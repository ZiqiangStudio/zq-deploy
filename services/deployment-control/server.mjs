import { createHmac, createSign, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const required = [
  'GITHUB_APP_ID',
  'GITHUB_APP_PRIVATE_KEY_B64',
  'GITHUB_WEBHOOK_SECRET',
  'GITHUB_INSTALLATION_ID',
  'PROJECT_OWNER',
  'PROJECT_NUMBER',
  'DEPLOY_TARGETS_JSON',
  'AGENT_TOKENS_JSON',
];
for (const name of required) {
  if (!process.env[name]) throw new Error(`Missing ${name}`);
}

const config = {
  appId: process.env.GITHUB_APP_ID,
  privateKey: Buffer.from(process.env.GITHUB_APP_PRIVATE_KEY_B64, 'base64').toString('utf8'),
  webhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
  installationId: process.env.GITHUB_INSTALLATION_ID,
  projectOwner: process.env.PROJECT_OWNER,
  projectNumber: Number(process.env.PROJECT_NUMBER),
  targets: JSON.parse(process.env.DEPLOY_TARGETS_JSON),
  agents: JSON.parse(process.env.AGENT_TOKENS_JSON),
  stateFile: process.env.STATE_FILE || '/data/deployment-state.json',
  leaseSeconds: Number(process.env.AGENT_LEASE_SECONDS || 900),
};
if (!Number.isInteger(config.projectNumber)) throw new Error('PROJECT_NUMBER must be an integer');
if (!Number.isInteger(config.leaseSeconds) || config.leaseSeconds < 60) throw new Error('AGENT_LEASE_SECONDS must be at least 60');
if (!config.targets || typeof config.targets !== 'object') throw new Error('DEPLOY_TARGETS_JSON must be an object');
if (!config.agents || typeof config.agents !== 'object') throw new Error('AGENT_TOKENS_JSON must be an object');
for (const [environment, target] of Object.entries(config.targets)) {
  if (!environment || !target || typeof target !== 'string' || !config.agents[target]) {
    throw new Error(`Target ${environment} must point to an agent with a token`);
  }
}

let installationToken;
let state = await loadState();

async function loadState() {
  try {
    const value = JSON.parse(await readFile(config.stateFile, 'utf8'));
    if (!Array.isArray(value.jobs)) throw new Error('state.jobs must be an array');
    return value;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await mkdir(dirname(config.stateFile), { recursive: true });
    return { jobs: [] };
  }
}

async function saveState() {
  await mkdir(dirname(config.stateFile), { recursive: true });
  const temporary = `${config.stateFile}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, config.stateFile);
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function appJwt() {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    iat: Math.floor(Date.now() / 1000) - 60,
    exp: Math.floor(Date.now() / 1000) + 540,
    iss: config.appId,
  }));
  const unsigned = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  return `${unsigned}.${signer.sign(config.privateKey, 'base64url')}`;
}

async function githubToken() {
  if (installationToken && installationToken.expiresAt > Date.now() + 60_000) return installationToken.value;
  const response = await fetch(`https://api.github.com/app/installations/${config.installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${appJwt()}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'zq-platform-deployment-control',
    },
  });
  if (!response.ok) throw new Error(`GitHub installation token failed: ${response.status} ${await response.text()}`);
  const data = await response.json();
  installationToken = { value: data.token, expiresAt: Date.parse(data.expires_at) };
  return installationToken.value;
}

async function githubApi(path, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${await githubToken()}`,
      'content-type': 'application/json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'zq-platform-deployment-control',
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`GitHub API failed: ${response.status} ${JSON.stringify(data)}`);
  return data;
}

async function graphql(query, variables) {
  const data = await githubApi('/graphql', { method: 'POST', body: JSON.stringify({ query, variables }) });
  if (data.errors?.length) throw new Error(`GitHub GraphQL failed: ${JSON.stringify(data.errors)}`);
  return data.data;
}

function parseJson(value, name) {
  try {
    return typeof value === 'string' ? JSON.parse(value || '{}') : value || {};
  } catch (error) {
    throw new Error(`${name} is not valid JSON: ${error.message}`);
  }
}

function imageDigest(imageRefs) {
  const value = Object.values(imageRefs)[0];
  const match = typeof value === 'string' ? value.match(/@sha256:[0-9a-f]{64}$/) : null;
  return match ? match[0].slice(1) : null;
}

function validateImageRefs(imageRefs) {
  if (!imageRefs || typeof imageRefs !== 'object' || Array.isArray(imageRefs) || Object.keys(imageRefs).length === 0) {
    throw new Error('image_refs must be a non-empty object');
  }
  for (const [name, ref] of Object.entries(imageRefs)) {
    if (!/^[a-zA-Z0-9._-]+$/.test(name) || typeof ref !== 'string' || !/@sha256:[0-9a-f]{64}$/.test(ref)) {
      throw new Error(`image_refs.${name} must be an immutable image reference`);
    }
  }
}

function deploymentPayload(job, platformState, errorMessage = null) {
  return JSON.stringify({
    schema: 'zq-platform/deployment/v1',
    service: job.service,
    server: job.target,
    platform_state: platformState,
    image_digest: imageDigest(job.imageRefs),
    deployed_at: new Date().toISOString(),
    error: errorMessage,
  });
}

async function setDeploymentStatus(job, stateName, platformState, errorMessage = null) {
  await githubApi(`/repos/${job.repository}/deployments/${job.deploymentId}/statuses`, {
    method: 'POST',
    body: JSON.stringify({
      state: stateName,
      environment: job.environment,
      description: errorMessage ? `${platformState}：${errorMessage}` : platformState,
      auto_inactive: false,
      payload: deploymentPayload(job, platformState, errorMessage),
    }),
  });
}

async function updateProject({ service, environment, server, stateName, imageDigestValue, deployedAt }) {
  const data = await graphql(`
    query($login: String!, $number: Int!) {
      organization(login: $login) {
        projectV2(number: $number) {
          id
          fields(first: 100) {
            nodes {
              __typename
              ... on ProjectV2Field { id name }
              ... on ProjectV2SingleSelectField { id name options { id name } }
            }
          }
          items(first: 100) {
            nodes {
              id
              content {
                __typename
                ... on DraftIssue { title }
                ... on Issue { title }
                ... on PullRequest { title }
              }
            }
          }
        }
      }
    }`, { login: config.projectOwner, number: config.projectNumber });
  const project = data.organization?.projectV2;
  if (!project) throw new Error(`Project ${config.projectOwner}/${config.projectNumber} was not found`);

  const field = name => {
    const value = project.fields.nodes.find(node => node.name === name);
    if (!value) throw new Error(`Project field was not found: ${name}`);
    return value;
  };
  const option = (name, optionName) => {
    const value = field(name);
    const selected = value.options?.find(item => item.name === optionName);
    if (!selected) throw new Error(`Option ${optionName} was not found in ${name}`);
    return [value.id, selected.id];
  };
  const update = async (itemId, fieldId, value) => {
    await graphql(`
      mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: ProjectV2FieldValue!) {
        updateProjectV2ItemFieldValue(input: {
          projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: $value
        }) { projectV2Item { id } }
      }`, { projectId: project.id, itemId, fieldId, value });
  };

  let item = project.items.nodes.find(node => node.content?.title === service);
  if (!item) {
    const created = await graphql(`
      mutation($projectId: ID!, $title: String!, $body: String!) {
        addProjectV2DraftIssue(input: { projectId: $projectId, title: $title, body: $body }) { projectItem { id } }
      }`, { projectId: project.id, title: service, body: `服务：${service}` });
    item = created.addProjectV2DraftIssue.projectItem;
  }

  await update(item.id, field('服务').id, { text: service });
  const [environmentId, environmentOption] = option('环境', environment);
  await update(item.id, environmentId, { singleSelectOptionId: environmentOption });
  const [serverId, serverOption] = option('服务器', server);
  await update(item.id, serverId, { singleSelectOptionId: serverOption });
  const [stateId, stateOption] = option('部署状态', stateName);
  await update(item.id, stateId, { singleSelectOptionId: stateOption });
  if (imageDigestValue) await update(item.id, field('镜像 Digest').id, { text: imageDigestValue });
  await update(item.id, field('最近部署').id, { date: deployedAt.slice(0, 10) });
}

function validSignature(raw, signature) {
  if (!signature?.startsWith('sha256=')) return false;
  const expected = Buffer.from(`sha256=${createHmac('sha256', config.webhookSecret).update(raw).digest('hex')}`);
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function validAgent(request) {
  const agentId = request.headers['x-zq-agent-id'];
  const authorization = request.headers.authorization || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  const expected = config.agents[agentId];
  if (!agentId || !expected || !token) return false;
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(token);
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

function agentId(request) {
  return request.headers['x-zq-agent-id'];
}

async function readBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 1_048_576) throw new Error('request body is too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(value));
}

async function enqueueDeployment(event) {
  const deployment = event.deployment;
  const payload = parseJson(deployment.payload, 'deployment.payload');
  if (payload.schema !== 'zq-platform/deployment/v1') return;
  const environment = deployment.environment;
  const target = config.targets[environment];
  if (!target) throw new Error(`No deployment target for environment ${environment}`);
  validateImageRefs(payload.image_refs);
  const repository = event.repository?.full_name;
  const service = payload.service || event.repository?.name;
  if (!repository || !service || payload.repository && payload.repository !== repository) throw new Error('deployment identity is invalid');

  const key = `${repository}#${deployment.id}`;
  if (state.jobs.some(job => job.key === key)) return;
  const job = {
    key,
    deploymentId: deployment.id,
    repository,
    service,
    environment,
    target,
    ref: deployment.ref,
    sha: payload.sha || deployment.sha || deployment.ref,
    imageRefs: payload.image_refs,
    domain: payload.domain || null,
    port: payload.port || null,
    healthcheckPath: payload.healthcheck_path || null,
    env: payload.env && typeof payload.env === 'object' && !Array.isArray(payload.env) ? payload.env : null,
    status: 'queued',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await setDeploymentStatus(job, 'in_progress', '部署中');
  state.jobs.push(job);
  await saveState();
  await updateProject({
    service: job.service,
    environment: job.environment,
    server: job.target,
    stateName: '部署中',
    imageDigestValue: imageDigest(job.imageRefs),
    deployedAt: job.createdAt,
  });
}

async function pollJob(request, response) {
  if (!validAgent(request)) return response.writeHead(401).end('invalid agent credentials');
  const id = agentId(request);
  const now = Date.now();
  for (const job of state.jobs) {
    if (job.status === 'running' && Date.parse(job.leaseExpiresAt) <= now) {
      job.status = 'queued';
      delete job.agentId;
      delete job.leaseExpiresAt;
    }
  }
  const job = state.jobs.find(item => item.target === id && item.status === 'queued');
  if (!job) return response.writeHead(204).end();
  job.status = 'running';
  job.agentId = id;
  job.leaseExpiresAt = new Date(now + config.leaseSeconds * 1000).toISOString();
  job.updatedAt = new Date(now).toISOString();
  await saveState();
  json(response, 200, job);
}

async function reportJob(request, response, id) {
  if (!validAgent(request)) return response.writeHead(401).end('invalid agent credentials');
  const job = state.jobs.find(item => item.key === id);
  if (!job || job.target !== agentId(request)) return response.writeHead(404).end('job not found');
  if (job.status !== 'running') return response.writeHead(409).end('job is not running');
  const body = parseJson((await readBody(request)).toString('utf8'), 'status body');
  if (!['success', 'failure'].includes(body.status)) return response.writeHead(400).end('status must be success or failure');
  const errorMessage = body.error ? String(body.error).slice(0, 500) : null;
  job.status = body.status;
  job.updatedAt = new Date().toISOString();
  delete job.leaseExpiresAt;
  await saveState();
  await setDeploymentStatus(job, body.status, body.status === 'success' ? '成功' : '失败', errorMessage);
  await updateProject({
    service: job.service,
    environment: job.environment,
    server: job.target,
    stateName: body.status === 'success' ? '成功' : '失败',
    imageDigestValue: imageDigest(job.imageRefs),
    deployedAt: job.updatedAt,
  });
  json(response, 200, { status: job.status });
}

async function handleWebhook(request, response) {
  const raw = await readBody(request);
  if (!validSignature(raw, request.headers['x-hub-signature-256'])) return response.writeHead(401).end('invalid signature');
  const eventName = request.headers['x-github-event'];
  if (!['deployment', 'deployment_status'].includes(eventName)) return response.writeHead(204).end();
  const event = JSON.parse(raw.toString('utf8'));
  if (eventName === 'deployment') await enqueueDeployment(event);
  if (eventName === 'deployment_status') {
    const deployment = event.deployment;
    const status = event.deployment_status;
    const payload = parseJson(status.payload, 'deployment_status.payload');
    const stateName = payload.platform_state || ({ success: '成功', failure: '失败', error: '失败', in_progress: '部署中' }[status.state]);
    const deployedAt = payload.deployed_at || status.created_at;
    const service = event.repository?.name;
    if (!service || !stateName || !deployedAt || !payload.server) return response.writeHead(204).end();
    await updateProject({
      service,
      environment: deployment.environment,
      server: payload.server,
      stateName,
      imageDigestValue: payload.image_digest,
      deployedAt,
    });
  }
  response.writeHead(204).end();
}

async function handle(request, response) {
  const url = new URL(request.url, 'http://localhost');
  if (request.method === 'GET' && url.pathname === '/healthz') return response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end('ok');
  if (request.method === 'POST' && url.pathname === '/github/webhook') return handleWebhook(request, response);
  if (request.method === 'GET' && url.pathname === '/agent/jobs/next') return pollJob(request, response);
  if (request.method === 'POST' && url.pathname.startsWith('/agent/jobs/') && url.pathname.endsWith('/status')) {
    const id = decodeURIComponent(url.pathname.slice('/agent/jobs/'.length, -'/status'.length));
    return reportJob(request, response, id);
  }
  response.writeHead(404).end();
}

createServer((request, response) => {
  handle(request, response).catch(error => {
    console.error(error);
    if (!response.headersSent) response.writeHead(500);
    response.end('deployment control failed');
  });
}).listen(Number(process.env.PORT || 8080), '0.0.0.0');
