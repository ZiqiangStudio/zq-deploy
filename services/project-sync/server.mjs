import { createHmac, createSign, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

const required = ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY_B64', 'GITHUB_WEBHOOK_SECRET', 'GITHUB_INSTALLATION_ID', 'PROJECT_OWNER', 'PROJECT_NUMBER'];
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
};
if (!Number.isInteger(config.projectNumber)) throw new Error('PROJECT_NUMBER must be an integer');

let installationToken;

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
      'user-agent': 'zq-platform-project-sync',
    },
  });
  if (!response.ok) throw new Error(`GitHub installation token failed: ${response.status} ${await response.text()}`);
  const data = await response.json();
  installationToken = { value: data.token, expiresAt: Date.parse(data.expires_at) };
  return installationToken.value;
}

async function graphql(query, variables) {
  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${await githubToken()}`,
      'content-type': 'application/json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'zq-platform-project-sync',
    },
    body: JSON.stringify({ query, variables }),
  });
  const data = await response.json();
  if (!response.ok || data.errors?.length) throw new Error(`GitHub GraphQL failed: ${JSON.stringify(data.errors ?? data)}`);
  return data.data;
}

async function updateProject({ service, environment, server, state, imageDigest, deployedAt }) {
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
  const [stateId, stateOption] = option('部署状态', state);
  await update(item.id, stateId, { singleSelectOptionId: stateOption });
  if (imageDigest) await update(item.id, field('镜像 Digest').id, { text: imageDigest });
  await update(item.id, field('最近部署').id, { date: deployedAt.slice(0, 10) });
}

function validSignature(raw, signature) {
  if (!signature?.startsWith('sha256=')) return false;
  const expected = Buffer.from(`sha256=${createHmac('sha256', config.webhookSecret).update(raw).digest('hex')}`);
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function handle(request, response) {
  if (request.method === 'GET' && request.url === '/healthz') {
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end('ok');
    return;
  }
  if (request.method !== 'POST' || request.url !== '/github/webhook') {
    response.writeHead(404).end();
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks);
  if (!validSignature(raw, request.headers['x-hub-signature-256'])) {
    response.writeHead(401).end('invalid signature');
    return;
  }
  if (request.headers['x-github-event'] !== 'deployment_status') {
    response.writeHead(204).end();
    return;
  }

  const event = JSON.parse(raw.toString('utf8'));
  const deployment = event.deployment;
  const status = event.deployment_status;
  const payload = typeof deployment.payload === 'string' ? JSON.parse(deployment.payload || '{}') : deployment.payload || {};
  const service = event.repository?.name;
  const state = payload.platform_state || ({ success: '成功', failure: '失败', error: '失败', in_progress: '部署中' }[status.state]);
  if (!service || !state || !payload.server || !payload.deployed_at) throw new Error('Deployment event is missing service, state, server, or deployed_at');
  await updateProject({
    service,
    environment: deployment.environment,
    server: payload.server,
    state,
    imageDigest: payload.image_digest,
    deployedAt: payload.deployed_at,
  });
  response.writeHead(204).end();
}

const server = createServer((request, response) => {
  handle(request, response).catch(error => {
    console.error(error);
    if (!response.headersSent) response.writeHead(500);
    response.end('project sync failed');
  });
});
server.listen(Number(process.env.PORT || 8080), '0.0.0.0');
