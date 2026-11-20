#!/usr/bin/env bash
set -Eeuo pipefail

service="$1"
config="$2"
env_file="$3"
image_refs="$4"

preset="$(sed -n 's/^preset:[[:space:]]*//p' "${config}" | head -n 1 | tr -d '\r')"
if [[ ! "${preset}" =~ ^[a-z0-9-]+$ ]]; then
  echo "Invalid preset in ${config}" >&2
  exit 1
fi

case "${preset}" in
  django-web|django-nginx)
    image_key=backend
    ;;
  django-suite)
    image_key=django
    ;;
  *)
    echo "No standard deployment check for preset ${preset}"
    exit 0
    ;;
esac

image="$(jq -er --arg key "${image_key}" '.[$key]' <<<"${image_refs}")"
[[ -n "${image}" ]] || { echo "Missing ${image_key} image reference" >&2; exit 1; }
[[ -s "${env_file}" ]] || { echo "Missing staged runtime environment" >&2; exit 1; }

log="$(mktemp)"
trap 'rm -f "${log}"' EXIT

if ! timeout --signal=TERM --kill-after=10s 180s \
  docker run --rm \
    --network host \
    --read-only \
    --tmpfs /tmp:rw,noexec,nosuid,size=128m,mode=1777 \
    --cap-drop ALL \
    --security-opt no-new-privileges:true \
    --env-file "${env_file}" \
    "${image}" python manage.py check_deployment >"${log}" 2>&1; then
  echo "Standard deployment check failed for preset ${preset} (service ${service})" >&2
  exit 1
fi

echo "Standard deployment check passed for preset ${preset} (service ${service})"
