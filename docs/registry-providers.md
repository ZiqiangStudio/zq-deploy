# 注册表提供商适配

平台核心只约定三个值：注册表主机、镜像命名空间、不可变的 `image@sha256:digest`。构建阶段通过 GitHub Actions 的注册表登录适配器完成认证；服务器阶段由同一注册表的凭据刷新适配器写入两个 `0600` 文件，代理在每次部署任务开始时读取文件并在任务结束后退出 Docker 登录会话。

当前内置适配器：

| provider | 构建认证 | 服务器凭据 | 适用场景 |
| --- | --- | --- | --- |
| `github` | GitHub OIDC/GITHUB_TOKEN | 主机维护的用户名和令牌文件 | GHCR |
| `static` | GitHub secret | 主机维护的用户名和令牌文件 | 暂不支持 OIDC 的注册表 |
| `aliyun-acr` | GitHub OIDC → RAM → ACR 临时凭据 | ECS RAM 角色 → ACR 临时凭据 | Alibaba ACR |

业务仓库只配置 `REGISTRY_HOST`、`REGISTRY_NAMESPACE`、`REGISTRY_PROVIDER` 及 provider 所需的参数。部署控制面不读取任何云厂商 API，换云时新增适配器并替换这些配置即可。

## 接入 Alibaba OIDC

在 GitHub 仓库或 `production` Environment 中设置以下变量；它们是路由和资源标识，不是密码：

```text
REGISTRY_PROVIDER=aliyun-acr
REGISTRY_HOST=<ACR 登录域名>
REGISTRY_NAMESPACE=<ACR 命名空间>
REGISTRY_REGION=<地域 ID>
REGISTRY_INSTANCE_ID=<ACR Enterprise 实例 ID>
REGISTRY_OIDC_PROVIDER_ARN=<RAM OIDC Provider ARN>
REGISTRY_ROLE_ARN=<RAM Role ARN>
REGISTRY_AUDIENCE=<与 RAM Provider 一致的 audience>
```

RAM OIDC Provider 的 issuer 使用 `https://token.actions.githubusercontent.com`，信任策略至少限制组织、仓库和 `main` 分支的 `sub`，并只授予构建所需的 ACR 推送权限。GitHub workflow job 必须声明 `id-token: write`；工作流会先用 GitHub OIDC 换取短期 RAM 凭据，再由 ACR adapter 登录 Docker，凭据不会写入 Deployment payload。

zq1 上另配置 ECS RAM 角色和 Alibaba CLI `EcsRamRole` profile，使用 `adapters/registry/aliyun-acr/refresh-token.sh` 每 45 分钟刷新 `registry-username`、`registry-token` 两个文件。代理每次任务读取这两个文件，因此临时令牌刷新不需要重启代理。

## 换云

换云不修改部署控制面、Deployment schema、Project 同步或服务器部署清单。只需要：

1. 在 `adapters/registry/` 增加构建登录和服务器凭据刷新适配器；
2. 为新 provider 配置注册表主机、命名空间和 provider 参数；
3. 在目标服务器安装该 provider 的刷新定时器并保持两个凭据文件接口。

只有当新云的认证流程无法映射到“构建时登录 + 服务器凭据文件”这两个接口时，才需要扩展平台接口；常见的 OIDC、短期 token 和静态 token 都不需要改核心。
