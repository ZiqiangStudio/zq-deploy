import { promises as fs } from 'node:fs';
import { readFileSync } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);

const required = ['DEPLOYER_URL', 'DEPLOY_AGENT_ID', 'DEPLOY_AGENT_TOKEN', 'DEPLOY_MANIFEST_DIR', 'AGENT_UPDATE_DIR', 'REGISTRY_HOST', 'REGISTRY_USERNAME_FILE', 'REGISTRY_TOKEN_FILE'];
for (const name of required) {
  if (!process.env[name]) throw new Error(`Missing ${name}`);
}

const config = {
  baseUrl: process.env.DEPLOYER_URL.replace(/\/$/, ''),
  agentId: process.env.DEPLOY_AGENT_ID,
  token: process.env.DEPLOY_AGENT_TOKEN,
  manifestDir: process.env.DEPLOY_MANIFEST_DIR,
  agentUpdateDir: process.env.AGENT_UPDATE_DIR,
  registryHost: process.env.REGISTRY_HOST,
  registryUsernameFile: process.env.REGISTRY_USERNAME_FILE,
  registryTokenFile: process.env.REGISTRY_TOKEN_FILE,
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
    const registryUsername = readFileSync(config.registryUsernameFile, 'utf8').trim();
    const registryToken = readFileSync(config.registryTokenFile, 'utf8').trim();
    if (!registryUsername) throw new Error('REGISTRY_USERNAME_FILE is empty');
    if (!registryToken) throw new Error('REGISTRY_TOKEN_FILE is empty');
    for (const host of registryHosts(job.imageRefs)) {
      if (host !== config.registryHost) throw new Error(`unsupported private registry: ${host}`);
      await command('docker', ['login', host, '--username', registryUsername, '--password-stdin'], `${registryToken}\n`);
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

function agentImage(job) {
  const image = job.imageRefs?.['deploy-agent'];
  if (!image || !/^[a-zA-Z0-9./:@_-]+$/.test(image)) throw new Error('job deploy-agent image is invalid');
  return image;
}

async function prepareAgentUpgrade(job) {
  const image = job.imageRefs?.['deploy-agent'];
  if (!image) return false;
  const pending = path.join(config.agentUpdateDir, 'pending-image');
  await fs.writeFile(pending, `${agentImage(job)}\n`, { mode: 0o600 });
  return true;
}

async function promoteAgentUpgrade(job) {
  if (!job.imageRefs?.['deploy-agent']) return;
  const pending = path.join(config.agentUpdateDir, 'pending-image');
  const desired = path.join(config.agentUpdateDir, 'desired-image');
  const pendingImage = (await fs.readFile(pending, 'utf8')).trim();
  if (pendingImage !== agentImage(job)) throw new Error('pending deploy-agent image does not match deployment');
  await fs.rename(pending, desired);
}

async function executeStandardDeployment(job) {
  const service = job.service;
  const image = job.imageDigest || Object.values(job.imageRefs || {})[0];
  if (!image) throw new Error('no image reference provided for deployment');

  console.log(`[${service}] pulling image ${image}...`);
  await execFileAsync('docker', ['pull', image]);

  const targetName = service;
  const tempName = `${service}-new-${Date.now()}`;

  const args = [
    'run', '-d',
    '--name', tempName,
    '--restart', 'unless-stopped',
    '--network', 'traefik',
    '--memory', process.env.DEFAULT_CONTAINER_MEMORY || '512m',
    '--memory-swap', process.env.DEFAULT_CONTAINER_MEMORY || '512m',
    '--cpus', process.env.DEFAULT_CONTAINER_CPUS || '1.5',
    '--log-opt', 'max-size=50m',
    '--log-opt', 'max-file=3',
  ];

  const secretEnv = `/etc/zq-deploy/secrets/${service}.env`;
  try {
    await fs.access(secretEnv);
    args.push('--env-file', secretEnv);
  } catch {}

  if (job.domain) {
    const domains = job.domain.split(',').map(d => d.trim()).filter(Boolean);
    const domainRule = domains.map(d => `Host(\`${d}\`)`).join(' || ');
    const port = String(job.port || 80);
    const routerName = service.replace(/_/g, '-');
    const certResolver = process.env.DEFAULT_CERT_RESOLVER || 'ziqiang-ali';
    args.push(
      '--label', 'traefik.enable=true',
      '--label', 'traefik.docker.network=traefik',
      '--label', `traefik.http.routers.${routerName}.rule=${domainRule}`,
      '--label', `traefik.http.routers.${routerName}.entrypoints=websecure`,
      '--label', `traefik.http.routers.${routerName}.tls=true`,
      '--label', `traefik.http.routers.${routerName}.tls.certresolver=${certResolver}`,
      '--label', `traefik.http.services.${routerName}.loadbalancer.server.port=${port}`
    );
  }

  args.push(image);

  console.log(`[${service}] starting container ${tempName}...`);
  await execFileAsync('docker', args);

  console.log(`[${service}] waiting for container to become ready...`);
  let ready = false;
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const { stdout } = await execFileAsync('docker', [
        'inspect',
        '--format',
        '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}',
        tempName,
      ]);
      const [status, health] = stdout.trim().split('|');
      if (status === 'running' && (health === 'healthy' || health === 'none')) {
        ready = true;
        break;
      }
      if (status === 'exited' || health === 'unhealthy') {
        break;
      }
    } catch {}
  }

  if (!ready) {
    console.error(`[${service}] container failed health check, cleaning up ${tempName}...`);
    await execFileAsync('docker', ['rm', '-f', tempName]).catch(() => {});
    throw new Error(`container ${tempName} did not become ready or healthy`);
  }

  console.log(`[${service}] promoting ${tempName} to ${targetName}...`);
  await execFileAsync('docker', ['rm', '-f', targetName]).catch(() => {});
  await execFileAsync('docker', ['rename', tempName, targetName]);

  await execFileAsync('docker', ['image', 'prune', '-f', '--filter', 'until=168h']).catch(() => {});
  console.log(`[${service}] deployment complete!`);
}

async function execute(job) {
  if (!/^[a-zA-Z0-9._-]+$/.test(job.service)) throw new Error('job service contains unsupported characters');
  await prepareAgentUpgrade(job);
  const loggedIn = await loginRegistries(job);
  try {
    const customScript = `${config.manifestDir}/${job.service}/deploy.sh`;
    let hasCustomScript = false;
    try {
      await fs.access(customScript, fs.constants.X_OK);
      hasCustomScript = true;
    } catch {}

    if (hasCustomScript) {
      const child = spawn('bash', [customScript], {
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
    } else {
      await executeStandardDeployment(job);
    }
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
        let success = false;
        try {
          await execute(job);
          await report(job, 'success', null);
          success = true;
        } catch (error) {
          console.error(error);
          await report(job, 'failure', error);
        }
        if (success) {
          try {
            await promoteAgentUpgrade(job);
          } catch (error) {
            console.error(`agent upgrade promotion failed: ${error.message || error}`);
          }
        }
      }
    } catch (error) {
      console.error(error);
    }
    await new Promise(resolve => setTimeout(resolve, config.intervalMs));
  }
}

run();
