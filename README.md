# zq-platform

自强 Studio 的组织级部署平台。业务仓库负责测试和构建不可变镜像；中央控制面负责把 GitHub Deployment 分发给当前服务器代理；代理在服务器本地执行 Compose、健康检查和回滚。

## 目录

- `.github/workflows/reusable-container.yml`：统一构建镜像并请求中央部署。
- `.github/workflows/reusable-deploy.yml`：创建标准 GitHub Deployment，载荷只包含环境和镜像 digest。
- `services/deployment-control/`：唯一中央控制面，接收 GitHub App Webhook、排队任务、更新 Deployment 和 Project。
- `services/deploy-agent/`：服务器代理，主动拉取任务并运行服务器上的部署清单。
- `contracts/deployment.schema.yml`：部署载荷和状态契约。
- `templates/compose/compose.yml`：Compose 运行基线。
- `backup/`：备份和恢复契约。
- `adapters/registry/`：注册表提供商适配器；云厂商 API 只允许出现在这里。
- `docs/registry-providers.md`：注册表认证和换云契约。
- `examples/`：业务仓库最小调用示例。

## 部署链路

```text
业务仓库 main
  -> reusable-container
  -> 构建并推送带 digest 的镜像
  -> reusable-deploy 创建 GitHub Deployment(environment + image_refs)
  -> deployment-control 根据环境映射排队
  -> 当前目标服务器上的 deploy-agent 拉取任务
  -> 服务器部署清单执行 Compose、健康检查、回滚
  -> control 更新 Deployment Status
  -> 同一 control 把状态同步到组织 Project
```

业务仓库不保存服务器地址、SSH 私钥、代理令牌或部署脚本。服务器地址变化只影响控制面的环境映射和服务器代理安装，不影响任何业务仓库。

## 中央控制面

`services/deployment-control` 使用一个 GitHub App Webhook，同时处理 `deployment` 和 `deployment_status` 事件。GitHub App 需要：

- Deployments：读写；
- Organization Projects：读写；
- Metadata：只读；
- Webhook Events：订阅 `deployment`、`deployment_status`。

运行变量：

```text
GITHUB_APP_ID
GITHUB_APP_PRIVATE_KEY_B64
GITHUB_WEBHOOK_SECRET
GITHUB_INSTALLATION_ID
PROJECT_OWNER=ZiqiangStudio
PROJECT_NUMBER=6
DEPLOY_TARGETS_JSON={"production":"zq1"}
AGENT_TOKENS_JSON={"zq1":"long-random-token"}
STATE_FILE=/data/deployment-state.json
AGENT_LEASE_SECONDS=900
PORT=8080
```

`DEPLOY_TARGETS_JSON` 是唯一的环境路由表。`production` 指向哪个代理由它决定；服务器更换时，在新服务器安装代理、使用新的令牌或接管同一个逻辑目标，再更新这张表即可。控制面数据必须放在持久卷中。

控制面可直接使用 `services/deployment-control/compose.yml` 运行。Webhook 地址为 `/github/webhook`，探活地址为 `/healthz`。

## 服务器代理

`services/deploy-agent` 在每台服务器运行，主动轮询控制面，不接受公网入站连接。代理使用服务器本地配置的注册表凭据拉取不可变镜像，凭据不进入 GitHub Deployment 或业务仓库。注册表提供商由 workflow 配置选择，云厂商 API 只存在于 `adapters/registry/`；部署控制面不依赖具体云。代理需要：

```text
DEPLOYER_URL=https://deploy.ziqiang.net.cn
DEPLOY_AGENT_ID=zq1
DEPLOY_AGENT_TOKEN=<与控制面配置一致的令牌>
DEPLOY_MANIFEST_DIR=/deployments
DEPLOY_INTERVAL_MS=5000
```

代理通过 Docker socket 执行部署清单 `/deployments/<service>/deploy.sh`。清单接收：

```text
DEPLOY_ENVIRONMENT
IMAGE_REFS       # 逻辑镜像名到完整 registry/image@sha256:digest 的 JSON
GITHUB_SHA
DEPLOYMENT_ID
```

清单必须幂等，完成 `docker compose pull/up`、健康检查和失败回滚；失败时返回非零状态。代理镜像和 Compose 见 `services/deploy-agent/`。

## 业务仓库接入

业务仓库只保留一个薄 workflow：

```yaml
name: Deploy

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read
  packages: write
  deployments: write

jobs:
  deploy:
    uses: ZiqiangStudio/zq-platform/.github/workflows/reusable-container.yml@main
    with:
      images: >-
        [{"name":"default","image":"example-service"}]
      deploy: true
      environment: production
      validate-script: .platform/validate.sh
    secrets: inherit
```

`images` 中构建出的每个镜像都会转换成不可变 digest 引用。固定依赖镜像也必须写 digest：

```json
{"name":"redis","build":false,"image":"redis","digest":"sha256:...","registry":"main"}
```

容器项目不再配置 `DEPLOY_HOST`、`DEPLOY_USER`、`DEPLOY_SSH_PRIVATE_KEY`、`DEPLOY_KNOWN_HOSTS`，也不再提供 `.platform/deploy.sh`。容器部署逻辑统一放在服务器的服务清单中，仓库只保留构建和验证所需文件。

## 服务器迁移

1. 在新服务器安装 Docker、Traefik 和 `deploy-agent`。
2. 放入该服务器负责的服务清单、生产环境文件和注册表凭据。
3. 为代理生成令牌，写入控制面 `AGENT_TOKENS_JSON`；把环境映射切换到新代理。
4. 先让代理通过 `/healthz` 和轮询接口，再合并业务仓库的部署 PR。
5. 旧服务器停止代理。业务仓库 workflow、镜像仓库和 GitHub Environment 不变。

不迁移数据库、Volume 或业务容器；这些属于服务器清单和备份恢复流程的独立变更。
