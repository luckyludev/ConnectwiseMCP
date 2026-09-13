"""Validate that rollback Compose services receive only their required secrets."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

GATEWAY_ENVIRONMENT = {
    "AZURE_AUDIENCE",
    "AZURE_CLIENT_ID",
    "AZURE_CLIENT_SECRET",
    "AZURE_SCOPES",
    "AZURE_TENANT_ID",
    "CONNECTWISE_API_URL",
    "CONNECTWISE_AUTH_PREFIX",
    "CONNECTWISE_COMPANY_ID",
    "CONNECTWISE_PRIVATE_KEY",
    "CONNECTWISE_PUBLIC_KEY",
    "JWT_SECRET_KEY",
    "MCP_RESOURCE_URL",
    "MCP_STATIC_TOKEN",
    "SERVER_URL",
}
TUNNEL_ENVIRONMENT = {"TUNNEL_TOKEN"}
CANARY_VALUES = {
    name: "compose-canary-" + name.lower().replace("_", "-")
    for name in GATEWAY_ENVIRONMENT
}
CANARY_VALUES["TUNNEL_TOKEN"] = "compose-canary-cloudflare-tunnel-token"


def _environment_keys(service: Any, name: str) -> set[str]:
    if not isinstance(service, dict):
        raise ValueError(f"Missing {name} service")
    environment = service.get("environment")
    if not isinstance(environment, dict):
        raise ValueError(f"{name} environment must be a mapping")
    return set(environment)


def validate_compose_config(config: Any, *, verify_canaries: bool = False) -> None:
    if not isinstance(config, dict) or not isinstance(config.get("services"), dict):
        raise ValueError("Compose config must contain services")
    services = config["services"]
    gateway = services.get("mcp-gateway")
    tunnel = services.get("cloudflared")
    gateway_keys = _environment_keys(gateway, "mcp-gateway")
    tunnel_keys = _environment_keys(tunnel, "cloudflared")

    if gateway_keys != GATEWAY_ENVIRONMENT:
        raise ValueError(
            "mcp-gateway environment differs from the required allowlist: "
            f"missing={sorted(GATEWAY_ENVIRONMENT - gateway_keys)}, "
            f"unexpected={sorted(gateway_keys - GATEWAY_ENVIRONMENT)}"
        )
    if tunnel_keys != TUNNEL_ENVIRONMENT:
        raise ValueError(
            "cloudflared environment differs from the tunnel-only allowlist: "
            f"missing={sorted(TUNNEL_ENVIRONMENT - tunnel_keys)}, "
            f"unexpected={sorted(tunnel_keys - TUNNEL_ENVIRONMENT)}"
        )
    if verify_canaries:
        rendered = {**gateway["environment"], **tunnel["environment"]}
        mismatches = sorted(
            name for name, expected in CANARY_VALUES.items() if rendered.get(name) != expected
        )
        if mismatches:
            raise ValueError(
                "Compose environment values do not match their source canaries: "
                + ", ".join(mismatches)
            )


def main() -> None:
    if len(sys.argv) not in {2, 3} or (
        len(sys.argv) == 3 and sys.argv[2] != "--verify-canaries"
    ):
        raise SystemExit(
            "usage: verify_compose_secret_isolation.py COMPOSE_CONFIG.json "
            "[--verify-canaries]"
        )
    config = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    try:
        validate_compose_config(config, verify_canaries=len(sys.argv) == 3)
    except ValueError as error:
        raise SystemExit(str(error)) from error


if __name__ == "__main__":
    main()
