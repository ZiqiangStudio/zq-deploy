# Alibaba ACR adapter

这个适配器只负责在服务器上用 ECS RAM 角色调用 ACR `GetAuthorizationToken`，并原子更新代理读取的用户名、令牌文件。中央控制面、GitHub Deployment 载荷和部署代理不依赖 Alibaba API。

服务器配置由环境文件提供：

```text
ALIBABA_CLI_PROFILE=zq-platform-ecs-role
ACR_API_ENDPOINT=cr.cn-hangzhou.aliyuncs.com
ACR_REGION_ID=cn-hangzhou
ACR_INSTANCE_ID=cri-xxxxxxxx
REGISTRY_USERNAME_FILE=/etc/zq-platform/secrets/registry-username
REGISTRY_TOKEN_FILE=/etc/zq-platform/secrets/registry-token
```

`ALIBABA_CLI_PROFILE` 应配置为 Alibaba CLI 的 `EcsRamRole` profile，角色只授予 `cr:GetAuthorizationToken`。用 systemd timer 每 45 分钟执行 `refresh-token.sh`，令牌更新失败时保留上一次有效文件并让服务告警；不要把 AccessKey 写入仓库、镜像或 systemd unit。

换云时保留上述文件接口，替换本目录适配器和对应的刷新定时器；业务 workflow 只需改注册表 provider 配置。
