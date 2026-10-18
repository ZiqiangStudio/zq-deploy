#!/usr/bin/env bash
set -Eeuo pipefail

: "${DEPLOY_AGENT_IMAGE_FILE:?DEPLOY_AGENT_IMAGE_FILE is required}"
: "${DEPLOY_AGENT_ENV_FILE:?DEPLOY_AGENT_ENV_FILE is required}"
: "${DEPLOY_AGENT_COMPOSE_FILE:?DEPLOY_AGENT_COMPOSE_FILE is required}"
: "${DEPLOY_AGENT_SERVICE:?DEPLOY_AGENT_SERVICE is required}"

desired=$(tr -d '\r\n' < "${DEPLOY_AGENT_IMAGE_FILE}")
[[ "${desired}" =~ ^[a-zA-Z0-9./:@_-]+$ ]] || { echo 'invalid deploy-agent image' >&2; exit 1; }

current=$(awk -F= '$1 == "DEPLOY_AGENT_IMAGE" { print substr($0, index($0, "=") + 1); exit }' "${DEPLOY_AGENT_ENV_FILE}")
[[ "${current}" == "${desired}" ]] && exit 0

tmp=$(mktemp "${DEPLOY_AGENT_ENV_FILE}.XXXXXX")
awk -v image="${desired}" '
  $1 == "DEPLOY_AGENT_IMAGE" { print "DEPLOY_AGENT_IMAGE=" image; replaced = 1; next }
  { print }
  END { if (!replaced) print "DEPLOY_AGENT_IMAGE=" image }
' "${DEPLOY_AGENT_ENV_FILE}" > "${tmp}"
chmod 600 "${tmp}"
mv "${tmp}" "${DEPLOY_AGENT_ENV_FILE}"
docker compose --env-file "${DEPLOY_AGENT_ENV_FILE}" -f "${DEPLOY_AGENT_COMPOSE_FILE}" up -d --no-deps "${DEPLOY_AGENT_SERVICE}"
