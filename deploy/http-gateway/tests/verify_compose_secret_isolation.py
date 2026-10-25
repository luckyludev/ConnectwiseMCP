"""Validate that rollback Compose services receive only their required secrets."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

CLOUDFLARED_IMAGE_PATTERN = re.compile(
    r"cloudflare/cloudflared:latest@sha256:[0-9a-f]{64}\Z"
)

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
EXPECTED_SERVICES = {"mcp-gateway", "cloudflared"}
EXPECTED_LOGGING = {
    "driver": "json-file",
    "options": {"max-file": "3", "max-size": "10m"},
}
EXPECTED_GATEWAY_BUILD_CONTEXT = Path(__file__).resolve().parents[2]
ALLOWED_SERVICE_FIELDS = {
    "mcp-gateway": {
        "build",
        "cap_drop",
        "command",
        "container_name",
        "entrypoint",
        "environment",
        "image",
        "logging",
        "networks",
        "ports",
        "restart",
        "security_opt",
    },
    "cloudflared": {
        "cap_drop",
        "command",
        "container_name",
        "depends_on",
        "entrypoint",
        "environment",
        "image",
        "logging",
        "networks",
        "ports",
        "restart",
        "security_opt",
    },
}
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


def _validate_runtime_restrictions(service: Any, name: str) -> None:
    if not isinstance(service, dict):
        raise ValueError(f"Missing {name} service")
    if service.get("cap_drop") != ["ALL"]:
        raise ValueError(f"{name} must drop all Linux capabilities")
    if service.get("security_opt") != ["no-new-privileges:true"]:
        raise ValueError(f"{name} must forbid privilege acquisition")
    privileged = service.get("privileged")
    if privileged is not None and privileged is not False:
        raise ValueError(f"{name} must not run in privileged mode")
    cap_add = service.get("cap_add")
    if cap_add is not None and cap_add != []:
        raise ValueError(f"{name} must not add Linux capabilities")
    if service.get("network_mode") == "host":
        raise ValueError(f"{name} must not use host networking")
    pid = service.get("pid")
    if pid is not None and pid != "":
        raise ValueError(f"{name} must not share a PID namespace")
    ipc = service.get("ipc")
    if ipc is not None and ipc != "":
        raise ValueError(f"{name} must not share an IPC namespace")
    volumes = service.get("volumes")
    if volumes is not None and volumes != []:
        raise ValueError(f"{name} must not mount host or named volumes")
    devices = service.get("devices")
    if devices is not None and devices != []:
        raise ValueError(f"{name} must not access host devices")
    for lifecycle_field in ("pre_start", "post_start", "pre_stop"):
        lifecycle = service.get(lifecycle_field)
        if lifecycle is not None and lifecycle != []:
            raise ValueError(f"{name} must not define lifecycle containers")
    use_api_socket = service.get("use_api_socket")
    if use_api_socket is not None and use_api_socket is not False:
        raise ValueError(f"{name} must not access the container engine API socket")
    volumes_from = service.get("volumes_from")
    if volumes_from is not None and volumes_from != []:
        raise ValueError(f"{name} must not inherit another container's volumes")
    gpus = service.get("gpus")
    if gpus is not None and gpus != []:
        raise ValueError(f"{name} must not access host GPUs")
    deploy = service.get("deploy")
    if deploy is not None and deploy != {}:
        raise ValueError(f"{name} must not define deployment-level runtime access")
    unexpected_fields = set(service) - ALLOWED_SERVICE_FIELDS[name]
    if unexpected_fields:
        raise ValueError(
            f"{name} contains non-allowlisted service fields: "
            + ", ".join(sorted(unexpected_fields))
        )


def _validate_bounded_logging(service: dict[str, Any], name: str) -> None:
    if service.get("logging") != EXPECTED_LOGGING:
        raise ValueError(
            f"{name} logging must use json-file with max-size 10m and max-file 3"
        )


def _validate_gateway_build(gateway: dict[str, Any]) -> None:
    build = gateway.get("build")
    if not isinstance(build, dict) or set(build) != {"context", "dockerfile"}:
        raise ValueError("mcp-gateway build must contain only context and dockerfile")
    context = build["context"]
    if not isinstance(context, str) or Path(context).resolve() != (
        EXPECTED_GATEWAY_BUILD_CONTEXT
    ):
        raise ValueError("mcp-gateway build context must be the reviewed deploy directory")
    if build["dockerfile"] != "http-gateway/Dockerfile":
        raise ValueError("mcp-gateway must use the reviewed rollback Dockerfile")


def _validate_service_execution(
    gateway: dict[str, Any], tunnel: dict[str, Any]
) -> None:
    if gateway.get("command") is not None or gateway.get("entrypoint") is not None:
        raise ValueError("mcp-gateway command and entrypoint must come from its image")
    if tunnel.get("command") != ["tunnel", "run"]:
        raise ValueError("cloudflared command must be exactly 'tunnel run'")
    if tunnel.get("entrypoint") is not None:
        raise ValueError("cloudflared entrypoint must come from its pinned image")


def _validate_networks(
    config: dict[str, Any], gateway: dict[str, Any], tunnel: dict[str, Any]
) -> None:
    expected_attachment = {"default": None}
    if gateway.get("networks") != expected_attachment:
        raise ValueError("mcp-gateway must attach only to the default Compose network")
    if tunnel.get("networks") != expected_attachment:
        raise ValueError("cloudflared must attach only to the default Compose network")

    networks = config.get("networks")
    if not isinstance(networks, dict) or set(networks) != {"default"}:
        raise ValueError("Compose must define only its default network")
    default_network = networks["default"]
    if not isinstance(default_network, dict) or set(default_network) != {
        "ipam",
        "name",
    }:
        raise ValueError("The default Compose network must use only generated settings")
    if default_network["ipam"] != {}:
        raise ValueError("The default Compose network must not override IPAM")
    network_name = default_network["name"]
    if network_name != "http-gateway_default":
        raise ValueError("The default Compose network name is invalid")


def _validate_network_exposure(gateway: dict[str, Any], tunnel: dict[str, Any]) -> None:
    expected_gateway_ports = [
        {
            "mode": "ingress",
            "target": 8000,
            "published": "8000",
            "protocol": "tcp",
            "host_ip": "127.0.0.1",
        }
    ]
    if gateway.get("ports") != expected_gateway_ports:
        raise ValueError(
            "mcp-gateway must publish only TCP port 8000 on 127.0.0.1:8000"
        )
    tunnel_ports = tunnel.get("ports")
    if tunnel_ports is not None and tunnel_ports != []:
        raise ValueError("cloudflared must not publish host ports")


def validate_compose_config(config: Any, *, verify_canaries: bool = False) -> None:
    if not isinstance(config, dict) or not isinstance(config.get("services"), dict):
        raise ValueError("Compose config must contain services")
    services = config["services"]
    service_names = set(services)
    if service_names != EXPECTED_SERVICES:
        raise ValueError(
            "Compose services differ from the rollback allowlist: "
            f"missing={sorted(EXPECTED_SERVICES - service_names)}, "
            f"unexpected={sorted(service_names - EXPECTED_SERVICES)}"
        )
    gateway = services.get("mcp-gateway")
    tunnel = services.get("cloudflared")
    gateway_keys = _environment_keys(gateway, "mcp-gateway")
    tunnel_keys = _environment_keys(tunnel, "cloudflared")
    _validate_runtime_restrictions(gateway, "mcp-gateway")
    _validate_runtime_restrictions(tunnel, "cloudflared")
    _validate_bounded_logging(gateway, "mcp-gateway")
    _validate_bounded_logging(tunnel, "cloudflared")
    _validate_gateway_build(gateway)
    _validate_service_execution(gateway, tunnel)
    _validate_networks(config, gateway, tunnel)
    _validate_network_exposure(gateway, tunnel)

    tunnel_image = tunnel.get("image")
    if not isinstance(tunnel_image, str) or not CLOUDFLARED_IMAGE_PATTERN.fullmatch(
        tunnel_image
    ):
        raise ValueError(
            "cloudflared image must be the official latest tag pinned by a lowercase "
            "sha256 digest"
        )

    tunnel_dependencies = tunnel.get("depends_on")
    if not isinstance(tunnel_dependencies, dict) or set(tunnel_dependencies) != {
        "mcp-gateway"
    }:
        raise ValueError("cloudflared must depend only on mcp-gateway")
    gateway_dependency = tunnel_dependencies["mcp-gateway"]
    if (
        not isinstance(gateway_dependency, dict)
        or gateway_dependency.get("condition") != "service_healthy"
        or gateway_dependency.get("required", True) is not True
    ):
        raise ValueError(
            "cloudflared must wait for required mcp-gateway service_healthy"
        )

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
