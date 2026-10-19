#!/usr/bin/env bash
set -Eeuo pipefail

: "${ALIBABA_CLI_PROFILE:?ALIBABA_CLI_PROFILE is required}"
: "${ACR_API_ENDPOINT:?ACR_API_ENDPOINT is required}"
: "${ACR_REGION_ID:?ACR_REGION_ID is required}"
: "${ACR_INSTANCE_ID:?ACR_INSTANCE_ID is required}"
: "${REGISTRY_USERNAME_FILE:?REGISTRY_USERNAME_FILE is required}"
: "${REGISTRY_TOKEN_FILE:?REGISTRY_TOKEN_FILE is required}"

command -v aliyun >/dev/null
command -v jq >/dev/null

response=$(aliyun cr GetAuthorizationToken \
  --endpoint "${ACR_API_ENDPOINT}" \
  --region-id "${ACR_REGION_ID}" \
  --InstanceId "${ACR_INSTANCE_ID}" \
  --profile "${ALIBABA_CLI_PROFILE}" \
  --format json)
username=$(jq -er '(.TempUsername // .Data.TempUsername)' <<<"${response}")
token=$(jq -er '(.AuthorizationToken // .Data.AuthorizationToken)' <<<"${response}")

install -d -m 700 "$(dirname "${REGISTRY_USERNAME_FILE}")"
install -d -m 700 "$(dirname "${REGISTRY_TOKEN_FILE}")"
username_tmp=$(mktemp "${REGISTRY_USERNAME_FILE}.XXXXXX")
token_tmp=$(mktemp "${REGISTRY_TOKEN_FILE}.XXXXXX")
trap 'rm -f "${username_tmp}" "${token_tmp}"' EXIT
printf '%s\n' "${username}" >"${username_tmp}"
printf '%s\n' "${token}" >"${token_tmp}"
chmod 600 "${username_tmp}" "${token_tmp}"
mv -f "${username_tmp}" "${REGISTRY_USERNAME_FILE}"
mv -f "${token_tmp}" "${REGISTRY_TOKEN_FILE}"
