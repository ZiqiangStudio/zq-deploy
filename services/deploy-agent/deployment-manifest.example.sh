#!/usr/bin/env bash
set -Eeuo pipefail

: "${IMAGE_REFS:?IMAGE_REFS is required}"
: "${DEPLOY_ENVIRONMENT:?DEPLOY_ENVIRONMENT is required}"

# 服务器上的服务清单负责把镜像 refs 写入 Compose 使用的 env 文件。
# 具体项目应在此处执行 docker compose pull/up、健康检查和失败回滚。
project_dir=/etc/zq-platform/services/example-service
printf '%s\n' "${IMAGE_REFS}" > "${project_dir}/image-refs.json"
docker compose --project-directory "${project_dir}" --env-file "${project_dir}/.env" pull
docker compose --project-directory "${project_dir}" --env-file "${project_dir}/.env" up -d --remove-orphans
