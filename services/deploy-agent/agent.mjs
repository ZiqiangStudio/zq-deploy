import { spawn } from 'node:child_process';

const required = ['DEPLOYER_URL', 'DEPLOY_AGENT_ID', 'DEPLOY_AGENT_TOKEN', 'DEPLOY_MANIFEST_DIR', 'REGISTRY_HOST', 'REGISTRY_USERNAME', 'REGISTRY_TOKEN'];
for (const name of required) {
  if (!process.env[name]) throw new Error(`Missing ${name}`);
}

const config = {
  baseUrl: process.env.DEPLOYER_URL.replace(/\/$/, ''),
  agentId: process.env.DEPLOY_AGENT_ID,
  token: process.env.DEPLOY_AGENT_TOKEN,
  manifestDir: process.env.DEPLOY_MANIFEST_DIR,
  registryHost: process.env.REGISTRY_HOST,
  registryUsername: process.env.REGISTRY_USERNAME,
  registryToken: process.env.REGISTRY_TOKEN,
  intervalMs: Number(process.env.DEPLOY_INTERVAL_MS || 5000),
};
if (!Number.isInteger(config.intervalMs) || config.intervalMs < 1000) throw new Error('DEPLOY_INTERVAL_MS must be at least 1000');
if (!/^[a-zA-Z0-9._-]+$/.test(config.agentId)) throw new Error('DEPLOY_AGENT_ID contains unsupported characters');

const headers = {
  authorization: `Bearer ${config.token}`,
  'x-zq-agent-id': config.agentId,
};

async function poll() {
  const response = await fetch(`${config.baseUrl}/agent/jobs/next`, { headers });
  if (response.status === 204) return null;
  if (!response.ok) throw new Error(`poll failed: ${response.status} ${await response.text()}`);
  return response.json();
}

function command(commandName, args, input = null) {
  const child = spawn(commandName, args, { stdio: ['pipe', 'inherit', 'inherit'] });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    if (input !== null) {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${commandName} exited with code ${code}`)));
  });
}

function registryHosts(imageRefs) {
  return [...new Set(Object.values(imageRefs).map(ref => String(ref).split('/')[0]).filter(host => host.includes('.') || host.includes(':') || host === 'localhost'))];
}

async function loginRegistries(job) {
  const loggedIn = [];
  try {
    for (const host of registryHosts(job.imageRefs)) {
      if (host !== config.registryHost) throw new Error(`unsupported private registry: ${host}`);
      await command('docker', ['login', host, '--username', config.registryUsername, '--password-stdin'], `${config.registryToken}\n`);
      loggedIn.push(host);
    }
    return loggedIn;
  } catch (error) {
    await logoutRegistries(loggedIn);
    throw error;
  }
}

async function logoutRegistries(hosts) {
  for (const host of hosts) await command('docker', ['logout', host]);
}

async function execute(job) {
  if (!/^[a-zA-Z0-9._-]+$/.test(job.service)) throw new Error('job service contains unsupported characters');
  const loggedIn = await loginRegistries(job);
  try {
    const script = `${config.manifestDir}/${job.service}/deploy.sh`;
    const child = spawn('bash', [script], {
      stdio: 'inherit',
      env: {
        ...process.env,
        DEPLOY_ENVIRONMENT: job.environment,
        IMAGE_REFS: JSON.stringify(job.imageRefs),
        GITHUB_SHA: job.sha,
        DEPLOYMENT_ID: String(job.deploymentId),
      },
    });
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`deployment adapter exited with code ${code}`)));
    });
  } finally {
    await logoutRegistries(loggedIn);
  }
}

async function report(job, status, error) {
  const response = await fetch(`${config.baseUrl}/agent/jobs/${encodeURIComponent(job.key)}/status`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ status, error: error ? String(error.message || error) : null }),
  });
  if (!response.ok) throw new Error(`status report failed: ${response.status} ${await response.text()}`);
}

async function run() {
  for (;;) {
    try {
      const job = await poll();
      if (job) {
        try {
          await execute(job);
          await report(job, 'success', null);
        } catch (error) {
          console.error(error);
          await report(job, 'failure', error);
        }
      }
    } catch (error) {
      console.error(error);
    }
    await new Promise(resolve => setTimeout(resolve, config.intervalMs));
  }
}

run();
