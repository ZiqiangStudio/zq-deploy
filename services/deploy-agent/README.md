# 服务器部署代理

代理运行在实际承载服务的服务器上，主动从中央控制面拉取任务，不需要 GitHub Actions 连接服务器，也不需要把服务器地址和 SSH 私钥放进业务仓库。

每个代理绑定一个逻辑目标，例如 `zq1`。生产环境到代理的映射由中央控制面的 `DEPLOY_TARGETS_JSON` 管理。服务器更换时，在新服务器安装代理并使用同一个逻辑目标，业务仓库和工作流不变。

代理从 `/deployments/<service>/deploy.sh` 执行服务部署适配器。适配器接收：

- `DEPLOY_ENVIRONMENT`
- `IMAGE_REFS`：逻辑镜像名到完整 digest 引用的 JSON
- `GITHUB_SHA`
- `DEPLOYMENT_ID`

适配器必须完成 Compose 更新、健康检查和失败回滚；返回非零状态后，控制面会把 GitHub Deployment 标记为失败。

代理需要访问 Docker socket，因此应使用专用系统用户、最小化部署目录权限，并只在受信任服务器上运行。

控制面会随任务返回短期 GitHub App installation token。代理只用它登录中央注册表，不会把令牌写入磁盘或传给部署脚本；任务结束后立即退出注册表会话。GitHub App 需要 `Packages: read` 权限。

`REGISTRY_HOST` 和 `REGISTRY_USERNAME` 是服务器配置，不写入业务仓库；它们必须与镜像引用使用的中央注册表一致。
