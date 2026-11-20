#!/usr/bin/env bash
set -Eeuo pipefail

service="$1"
stage_dir="$2"

[[ -n "${service}" ]] || { echo "Service name is required" >&2; exit 1; }
[[ -d "${stage_dir}" ]] || { echo "Staging directory is missing" >&2; exit 1; }
[[ -f "${stage_dir}/compose.yml" ]] || { echo "Staged compose file is missing" >&2; exit 1; }
[[ -s "${stage_dir}/.env" ]] || { echo "Staged runtime environment is missing" >&2; exit 1; }

export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-${service}}"
config_file="${stage_dir}/compose.json"
docker compose --project-directory "${stage_dir}" --env-file "${stage_dir}/.env" --file "${stage_dir}/compose.yml" config --format json >"${config_file}"

check_services="$(jq -r '.services | to_entries[] | select(.value.labels["zq.deploy.check"] == "true") | .key' "${config_file}")"
check_count="$(grep -c . <<<"${check_services}" || true)"
if [[ "${check_count}" -ne 1 ]]; then
  echo "Compose must declare exactly one service with label zq.deploy.check=true" >&2
  exit 1
fi

check_command="$(jq -r --arg name "${check_services}" '.services[$name].labels["zq.deploy.check.command"] // "python manage.py check_deployment"' "${config_file}")"
image="$(jq -r --arg name "${check_services}" '.services[$name].image' "${config_file}")"
[[ -n "${image}" && "${image}" != "null" ]] || { echo "Deployment check image is missing" >&2; exit 1; }

log="$(mktemp)"
trap 'rm -f "${log}"' EXIT
if ! timeout --signal=TERM --kill-after=10s 180s \
  docker compose --project-directory "${stage_dir}" --env-file "${stage_dir}/.env" --file "${stage_dir}/compose.yml" \
    run --rm --no-deps -T --entrypoint /bin/sh "${check_services}" -c "${check_command}" >"${log}" 2>&1; then
  echo "Deployment check failed for service ${service}" >&2
  exit 1
fi

echo "Deployment check passed for service ${service}"
