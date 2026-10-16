# zq-platform

自强 Studio 的组织级 GitHub Actions 部署基线。

这个仓库只维护跨项目共用的流水线接口。项目自身的云厂商命令、域名、服务器地址和业务配置放在项目仓库的 `.platform/deploy.sh`，通过 GitHub Environment 注入密钥。这样流水线可以统一升级，部署目标仍由项目明确负责。

## 约定

每个项目至少要有：

- 锁定依赖版本的 lockfile；
- 可重复执行的构建命令；
- 明确的产物路径，或可构建的 `Dockerfile`；
- 需要自动部署时提供 `.platform/deploy.sh`；
- `staging` 和 `production` 两个 GitHub Environment。

部署脚本通过环境变量接收平台输入：

```text
DEPLOY_ENVIRONMENT  staging 或 production
ARTIFACT_PATH       静态构建产物目录（静态项目）
IMAGE_REF           已发布且带 digest 的容器镜像（容器项目）
GITHUB_SHA          本次构建对应的提交
```

脚本应做到幂等：同一提交重复执行不会产生第二份不可追踪的发布状态。生产 Environment 配置必需的审批人和分支限制；云平台优先使用 GitHub OIDC，不在仓库中保存长期云密钥。

## 使用方式

项目复制 `examples/static-consumer.yml` 或 `examples/container-consumer.yml` 到 `.github/workflows/deploy.yml`，把构建参数、镜像名和部署脚本改成项目实际值。初期示例使用 `@main` 便于接入；平台发布第一个版本后，项目应改为固定版本或完整 commit SHA。

Pull Request 只执行检查和构建，不发布；合并到 `main` 自动发布 staging；版本 Tag 发布 production，并由 Environment 保护规则控制审批。

## 迁移顺序

先接入静态站点，再接入 Node SSR 和后端容器，最后迁移小程序和 npm/Python 包发布。不要让项目复制工作流实现细节；新增的通用逻辑应回到这里维护。
