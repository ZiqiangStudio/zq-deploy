# zq-platform

自强 Studio 的组织级部署基线：Compose 运行模板、可复用 GitHub Actions、统一部署事件、Project 同步和备份恢复契约都放在这里。业务仓库只声明构建入口和部署适配器，不复制流水线实现。

## 目录

- `contracts/service.schema.yml`：业务仓库接入平台时需要满足的字段。
- `templates/compose/compose.yml`：无状态应用的 Compose 基线。数据库、Redis、RabbitMQ 和 Volume 不由这个模板自动创建。
- `.github/workflows/reusable-container.yml`：容器项目的统一构建、推送和部署接口。
- `.github/workflows/reusable-static.yml`：静态站点的统一构建和部署接口。
- `.github/workflows/reusable-project-sync.yml`：把部署结果发布为标准 GitHub Deployment 事件。
- `services/project-sync/`：组织级 GitHub App Webhook 服务，把 Deployment 事件同步到组织 Project。
- `.github/workflows/reusable-backup-restore.yml`：备份和恢复演练接口，只调用业务仓库提供的适配器。
- `backup/`：备份分层、保留策略、恢复演练和命名约定。
- `examples/`：业务仓库中的最小调用示例。

## 部署状态链路

```text
业务仓库工作流
  -> reusable-container/reusable-static
  -> reusable-project-sync
  -> GitHub Deployment / Deployment Status
  -> GitHub App Webhook
  -> services/project-sync
  -> 组织 Project
```

业务仓库不保存 Project Token，也不直接调用 Project GraphQL。服务名称统一取 GitHub 仓库名，因此同一套同步服务可以处理组织内所有项目；环境、服务器、状态和镜像 digest 随 Deployment payload 传递。

`services/project-sync` 是无状态 OCI 镜像，可以运行在任意支持 Docker 的主机、云函数或容器平台。GitHub App 私钥和 Webhook Secret 由运行平台注入，迁移运行平台时不需要修改业务仓库工作流。

### GitHub App 配置

GitHub App 只安装到 `ZiqiangStudio` 组织，授予：

- Organization Projects：读写；
- Metadata：只读；
- Deployments：读写；
- Webhook：接收 `deployment_status`。

服务运行时需要这些变量：

```text
GITHUB_APP_ID
GITHUB_APP_PRIVATE_KEY_B64
GITHUB_WEBHOOK_SECRET
GITHUB_INSTALLATION_ID
PROJECT_OWNER=ZiqiangStudio
PROJECT_NUMBER=6
PORT=8080
```

Webhook 地址为 `/github/webhook`。服务验证 GitHub 签名后，只处理 `deployment_status`，重复事件可以安全重放，部署服务本身不依赖 Project 服务可用性。

## 统一接入方式

业务仓库保留一个很薄的调用文件：

```yaml
jobs:
  deploy:
    uses: ZiqiangStudio/zq-platform/.github/workflows/reusable-container.yml@<pinned-ref>
    with:
      images: >-
        [{"name":"default","image":"ghcr.io/ziqiangstudio/example-service"}]
      deploy: ${{ github.event_name == 'push' }}
      environment: production
      deploy-script: .platform/deploy.sh
    secrets: inherit

  deployment-event:
    if: github.event_name != 'pull_request' && needs.deploy.result == 'success'
    needs: deploy
    uses: ZiqiangStudio/zq-platform/.github/workflows/reusable-project-sync.yml@<pinned-ref>
    with:
      environment: production
      server: zq1
      state: 成功
      image-digest: ${{ needs.deploy.outputs.image-digest }}
      deployed-at: ${{ github.run_started_at }}
```

业务仓库必须提供：

- 可重复执行的构建入口和锁定依赖；
- `Dockerfile` 或明确的静态产物目录；
- `.platform/deploy.sh`，接收平台传入的 `IMAGE_REFS` 或 `ARTIFACT_PATH`；
- `.platform/backup.sh`，接收 `BACKUP_OPERATION=backup|restore-check`；
- `production` Environment；
- 健康检查和回滚方式。

部署适配器接收这些变量：

```text
DEPLOY_ENVIRONMENT  production 或明确命名的测试环境
ARTIFACT_PATH       静态构建产物目录
IMAGE_REFS           JSON 对象，值为已发布且带 digest 的容器镜像
GITHUB_SHA          本次构建对应的提交
```

生产部署只允许受保护的 Environment 触发，并使用固定的工作流版本或完整 commit SHA。部署脚本必须幂等，不能执行删除 Volume、删除数据库或无条件清理镜像。

## 当前边界

这次提交只建立配置、模板和流程契约，不连接 zq1/zq2，不迁移数据，也不删除线上容器或 Volume。真正接入项目时，先在隔离环境完成构建、恢复和健康检查，再启用生产 Environment。
