# zq-deploy

自强 Studio 组织级镜像构建与自动部署。业务仓库只保留一份薄 workflow，所有构建和部署都在组织自托管 runner 上完成，服务器使用固定的 compose 清单上线。

## 目录

- `.github/workflows/reusable-container.yml`：构建并推送镜像，按需调用部署。
- `.github/workflows/reusable-deploy.yml`：在 self-hosted runner 上直接执行服务器 compose 清单。
- `.github/workflows/reusable-pr-title.yml`：组织统一的 PR 标题与正文校验。
- `.github/workflows/reusable-backup-restore.yml`：备份与恢复检查。
- `contracts/deployment.schema.yml`：GitHub Deployment 载荷约定。
- `backup/`：备份策略与恢复说明。

## 部署链路

```text
业务仓库 push main
  -> reusable-container
  -> 在组织 runner 上构建并推送不可变镜像 digest
  -> reusable-deploy
  -> 将仓库的 .platform/compose.yml 和 RUNTIME_ENV 暂存为候选文件
  -> 用候选配置和本次镜像执行标准部署检查
  -> 通过后原子提升 compose.yml 和 .env，再执行 docker compose pull
  -> docker compose up -d --remove-orphans --force-recreate
  -> 轮询 docker compose ps，等待全部服务 running / healthy（最多 300 秒）
  -> 写入 GitHub Deployment 状态
```

运行时配置由仓库或 production Environment 的 `RUNTIME_ENV` Secret 提供。部署时 workflow 用其完整内容覆盖服务器 `.env`，每次 rollout 都强制重建容器，因为 Docker Compose 的配置哈希不包含 `.env` 文件内容，仅靠 `up -d` 会让环境变量更新停留在服务器文件上。

部署检查使用统一的应用契约：Compose 中恰好一个服务声明 `zq.deploy.check: "true"`，并在该服务镜像内提供 `python manage.py check_deployment`。平台在候选文件提升前，按该服务的 Compose 定义（镜像、环境、卷、网络）启动一次性容器执行命令；可以通过 `zq.deploy.check.command` 覆盖默认命令。检查失败时保留现有 `compose.yml`、`.env` 和容器。命令只输出固定状态文本，不输出运行时配置值。业务仓库无需提供服务器预检脚本，也无需了解 staging 目录或 Compose 输出格式。

业务仓库不需要保存服务器地址、SSH 私钥或部署脚本；服务器上也不需要控制面、代理或 `deploy.sh`。

## Runner

所有 reusable workflow 使用组织级 runner 标签：

```text
[self-hosted, linux, x64, zq-deploy]
```

runner 已注册在组织的 runner group 中，业务仓库只需要允许访问该 runner group，不需要为每个仓库安装或配置 runner。runner 用户需要能访问 Docker socket，并能读取 compose 清单、写入 `/etc/zq-deploy/deployments/<service>/` 下的 `.env`。

runner 主机预装 Docker Engine、Docker Compose v2、Git、jq、curl，以及 Python 项目常用的 `build-essential`、`pkg-config`、`default-libmysqlclient-dev`、`libpq-dev`。Node、Python 等语言版本由 workflow 的 setup action 安装。

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

Compose 的检查服务必须实现 `python manage.py check_deployment`。该命令使用当前环境完成只读部署检查，失败时返回非零状态；只输出固定状态文本，避免泄露 Secret。平台会在候选文件提升前按该服务的运行环境自动执行。

镜像会推送到 `registry.cn-hangzhou.aliyuncs.com/ziqiang_studio`，使用组织或仓库 Secrets 中的 `DOCKER_USERNAME` 和 `DOCKER_PASSWORD`。PR 只构建和校验，不登录 registry、不推送、不部署。

## 服务器清单

业务仓库提交 `.platform/compose.yml`，声明自己的服务拓扑。zq-deploy 校验候选 Compose，把它和 `RUNTIME_ENV` 一起安装到服务器固定目录：

```text
仓库: .platform/compose.yml
服务器: /etc/zq-deploy/deployments/<service>/compose.yml
服务器: /etc/zq-deploy/deployments/<service>/.env
```

`<service>` 等于 GitHub 仓库名。平台通过 `COMPOSE_PROJECT_NAME` 注入项目名，清单里不写 `name` 或 `container_name`，并使用构建输出的不可变镜像变量：

```yaml
services:
  app:
    image: ${IMAGE_REF:?IMAGE_REF is required}
    restart: unless-stopped
    env_file: ./.env
    networks: [app-net, traefik]
    labels:
      zq.deploy.check: "true"
      zq.deploy.check.command: "python manage.py check_deployment"
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

多镜像服务按 `name` 使用对应变量，例如 `backend` 和 `frontend` 对应 `${BACKEND_IMAGE_REF}` 和 `${FRONTEND_IMAGE_REF}`。域名、端口、健康检查和 `restart: unless-stopped` 都写在项目自己的 compose 清单里。
