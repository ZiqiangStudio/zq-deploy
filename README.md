# zq-platform

自强 Studio 的组织级部署基线：Compose 运行模板、可复用 GitHub Actions、部署 Project 同步和备份恢复契约都放在这里。业务仓库只描述自己的构建入口和很薄的部署适配器，不复制流水线实现。

## 目录

- `contracts/service.schema.yml`：业务仓库接入平台时需要满足的字段。
- `templates/compose/compose.yml`：无状态应用的 Compose 基线。数据库、Redis、RabbitMQ 和 Volume 不由这个模板自动创建。
- `.github/workflows/reusable-container.yml`：容器项目的统一构建、推送和部署接口。
- `.github/workflows/reusable-static.yml`：静态站点的统一构建和部署接口。
- `.github/workflows/reusable-project-sync.yml`：将部署结果写入组织 Project。
- `.github/workflows/reusable-backup-restore.yml`：备份和恢复演练接口，只调用业务仓库提供的适配器。
- `backup/`：备份分层、保留策略、恢复演练和命名约定。
- `examples/`：业务仓库中的最小调用示例。

## 统一接入方式

业务仓库保留一个很薄的调用文件：

```yaml
jobs:
  deploy:
    uses: ZiqiangStudio/zq-platform/.github/workflows/reusable-container.yml@<pinned-ref>
    with:
      image: ghcr.io/ziqiangstudio/example-service
      deploy: ${{ github.event_name == 'push' }}
      environment: production
      deploy-script: .platform/deploy.sh
    secrets: inherit
```

业务仓库必须提供：

- 可重复执行的构建入口和锁定依赖；
- `Dockerfile` 或明确的静态产物目录；
- `.platform/deploy.sh`，接收平台传入的 `IMAGE_REF` 或 `ARTIFACT_PATH`；
- `.platform/backup.sh`，接收 `BACKUP_OPERATION=backup|restore-check`；
- `production` Environment；
- 健康检查和回滚方式。

部署适配器接收这些变量：

```text
DEPLOY_ENVIRONMENT  production 或明确命名的测试环境
ARTIFACT_PATH       静态构建产物目录
IMAGE_REF           已发布且带 digest 的容器镜像
GITHUB_SHA          本次构建对应的提交
```

生产部署只允许受保护的 Environment 触发，并使用固定的工作流版本或完整 commit SHA。部署脚本必须幂等，不能执行删除 Volume、删除数据库或无条件清理镜像。

## 当前边界

这次提交只建立配置、模板和流程契约，不连接 zq1/zq2，不迁移数据，也不删除线上容器或 Volume。真正接入项目时，先在隔离环境完成构建、恢复和健康检查，再启用生产 Environment。
