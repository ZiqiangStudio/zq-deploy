# zq-deploy

自强 Studio 组织级镜像构建与自动部署。业务仓库只保留一份薄 workflow，所有构建和部署都在组织自托管 runner 上完成，服务器使用固定的 compose 清单上线。

## 目录

- `.github/workflows/reusable-container.yml`：构建并推送镜像，按需调用部署。
- `.github/workflows/reusable-deploy.yml`：在 self-hosted runner 上直接执行服务器 compose 清单。
- `.github/workflows/reusable-pr-title.yml`：组织统一的 PR 标题与正文校验。
- `.github/workflows/reusable-backup-restore.yml`：备份与恢复检查。
- `contracts/deployment.schema.yml`：GitHub Deployment 载荷约定。
- `templates/compose/compose.yml`：服务器 compose 清单模板。
- `backup/`：备份策略与恢复说明。
- `examples/`：业务仓库最小调用示例。

## 部署链路

```text
业务仓库 push main
  -> reusable-container
  -> 在组织 runner 上构建并推送不可变镜像 digest
  -> reusable-deploy
  -> 同一个 runner 执行 /etc/zq-deploy/deployments/<service>/compose.yml
  -> docker compose pull
  -> docker compose up -d --remove-orphans --wait
  -> 写入 GitHub Deployment 状态
```

业务仓库不需要保存服务器地址、SSH 私钥或部署脚本；服务器上也不需要控制面、代理或 `deploy.sh`。

## Runner

所有 reusable workflow 使用组织级 runner 标签：

```text
[self-hosted, linux, x64, zq-deploy]
```

runner 已注册在组织的 runner group 中，业务仓库只需要允许访问该 runner group，不需要为每个仓库安装或配置 runner。runner 用户需要能访问 Docker socket，并能读取 `/etc/zq-deploy/deployments/<service>/` 下的 compose 清单和 `.env`。

## 业务仓库接入

```yaml
name: Deploy

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read
  deployments: write

jobs:
  deploy:
    uses: ZiqiangStudio/zq-deploy/.github/workflows/reusable-container.yml@main
    secrets: inherit
    with:
      images: >-
        [{"name":"backend","image":"example-backend","context":"backend","dockerfile":"backend/Dockerfile"}]
      deploy: true
      environment: production
      validate-script: .platform/validate.sh
```

镜像定义支持：

- `name`：逻辑镜像名，部署时导出为 `<NAME>_IMAGE_REF`；`default` 导出为 `IMAGE_REF`。
- `image`：registry 中的镜像仓库名。
- `build`：默认 `true`；`false` 表示引用固定 digest 的依赖镜像。
- `digest`：`build: false` 时必填，格式 `sha256:<64位十六进制>`。
- `context` / `dockerfile`：构建上下文和 Dockerfile 路径。

镜像会推送到 `registry.cn-hangzhou.aliyuncs.com/ziqiang_studio`，使用组织或仓库 Secrets 中的 `DOCKER_USERNAME` 和 `DOCKER_PASSWORD`。PR 只构建和校验，不登录 registry、不推送、不部署。

## 服务器清单

每个服务在服务器上只需要一个目录：

```text
/etc/zq-deploy/deployments/<service>/
  compose.yml
  .env
```

`<service>` 等于 GitHub 仓库名。`compose.yml` 必须设置 `name: <service>`，并使用不可变镜像变量：

```yaml
name: example-service

services:
  app:
    image: ${IMAGE_REF:?IMAGE_REF is required}
    restart: unless-stopped
    env_file: ./.env
    networks: [app-net, traefik]
    labels:
      traefik.enable: "true"
      traefik.docker.network: traefik
      traefik.http.routers.example.rule: Host(`example.ziqiang.net.cn`)
      traefik.http.routers.example.entrypoints: websecure
      traefik.http.routers.example.tls: true
      traefik.http.routers.example.tls.certresolver: ziqiang-ali
      traefik.http.services.example.loadbalancer.server.port: "8000"

networks:
  app-net:
  traefik:
    external: true
```

多镜像服务按 `name` 使用对应变量，例如 `backend` 和 `frontend` 对应 `${BACKEND_IMAGE_REF}` 和 `${FRONTEND_IMAGE_REF}`。域名、端口、健康检查和 `restart: unless-stopped` 都写在这份 compose 清单里。

模板见 `templates/compose/compose.yml`，可直接复制后替换服务名、域名和端口。
