#!/usr/bin/env python3
"""Small validation for the platform inventory contract."""

from pathlib import Path
import sys

import yaml


ROOT = Path(__file__).resolve().parents[1]
INVENTORY = ROOT / "services" / "inventory.yml"
FORBIDDEN = {"password", "token", "secret", "private_key", "connection_string", "env_value"}


def walk(value, path=""):
    if isinstance(value, dict):
        for key, child in value.items():
            yield from walk(child, f"{path}.{key}" if path else key)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from walk(child, f"{path}[{index}]")
    else:
        yield path, value


def main() -> int:
    try:
        document = yaml.safe_load(INVENTORY.read_text(encoding="utf-8"))
    except Exception as exc:
        print(f"inventory parse failed: {exc}", file=sys.stderr)
        return 1

    if document.get("schema") != "zq-platform/v1":
        print("inventory schema must be zq-platform/v1", file=sys.stderr)
        return 1

    servers = set(document.get("servers", {}))
    services = document.get("services", [])
    ids = [service.get("id") for service in services]
    errors = []
    if len(ids) != len(set(ids)):
        errors.append("service ids must be unique")

    for service in services:
        service_id = service.get("id", "<missing>")
        for field in ("id", "server", "source", "runtime", "data", "cleanup_guard"):
            if field not in service:
                errors.append(f"{service_id}: missing {field}")
        if service.get("server") not in servers:
            errors.append(f"{service_id}: unknown server {service.get('server')}")
        for path, _value in walk(service):
            key = path.rsplit(".", 1)[-1].split("[", 1)[0].lower()
            if key in FORBIDDEN:
                errors.append(f"{service_id}: forbidden secret-like field {path}")

    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    print(f"validated {len(services)} services on {len(servers)} servers")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
