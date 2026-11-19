#!/usr/bin/env bash
set -Eeuo pipefail

service="$1"
config="$2"
output="$3"

platform_root="${ZQ_DEPLOY_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
preset="$(sed -n 's/^preset:[[:space:]]*//p' "${config}" | head -n 1 | tr -d '\r')"

if [[ ! "${preset}" =~ ^[a-z0-9-]+$ ]]; then
  echo "Invalid preset in ${config}" >&2
  exit 1
fi

template="${platform_root}/templates/${preset}.yml"
if [[ ! -f "${template}" ]]; then
  echo "Unknown preset: ${preset}" >&2
  exit 1
fi

router="${service//_/-}"
tmp="$(mktemp)"
trap 'rm -f "${tmp}"' EXIT
sed -e "s/__SERVICE__/${service}/g" -e "s/__ROUTER__/${router}/g" "${template}" >"${tmp}"
install -Dm644 "${tmp}" "${output}"
