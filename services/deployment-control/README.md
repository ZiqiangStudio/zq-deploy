# 中央部署控制面

`deployment-control` 是组织唯一的部署入口，同时处理三类事件：

1. GitHub App 的 `deployment` Webhook：校验镜像 digest，根据环境解析当前代理，并持久化任务。
2. 代理轮询和状态上报：分发任务，记录租约，回写成功或失败状态。
3. GitHub App 的 `deployment_status` Webhook：把服务器、环境、状态和镜像 digest 同步到组织 Project。

状态保存在 `STATE_FILE` 指向的持久卷中。控制面本身不保存服务器 SSH 凭据；服务器凭据和项目部署适配器只存在于服务器代理侧。

GitHub App 必须订阅 `deployment` 和 `deployment_status` 事件，并授予 Deployments 读写、Organization Projects 读写、Metadata 只读权限。

`DEPLOY_TARGETS_JSON` 只保存环境到逻辑代理名的映射，例如：

```json
{"production":"zq1"}
```

`AGENT_TOKENS_JSON` 保存代理名到随机长令牌的映射。令牌只写入代理主机和控制面运行环境，不进入 GitHub 仓库。
