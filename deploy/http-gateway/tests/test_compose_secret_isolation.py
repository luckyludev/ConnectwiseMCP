import pytest

from verify_compose_secret_isolation import (
    CANARY_VALUES,
    GATEWAY_ENVIRONMENT,
    TUNNEL_ENVIRONMENT,
    validate_compose_config,
)


def compose_config() -> dict:
    return {
        "services": {
            "mcp-gateway": {
                "environment": {name: f"gateway-{name}" for name in GATEWAY_ENVIRONMENT}
            },
            "cloudflared": {
                "environment": {name: f"tunnel-{name}" for name in TUNNEL_ENVIRONMENT}
            },
        }
    }


def test_accepts_exact_service_environment_allowlists():
    validate_compose_config(compose_config())


def test_canaries_verify_each_environment_value_source():
    config = compose_config()
    for service in config["services"].values():
        for name in service["environment"]:
            service["environment"][name] = CANARY_VALUES[name]

    validate_compose_config(config, verify_canaries=True)

    config["services"]["mcp-gateway"]["environment"]["MCP_STATIC_TOKEN"] = (
        CANARY_VALUES["TUNNEL_TOKEN"]
    )
    with pytest.raises(ValueError, match="MCP_STATIC_TOKEN"):
        validate_compose_config(config, verify_canaries=True)


@pytest.mark.parametrize(
    ("service", "secret"),
    [
        ("mcp-gateway", "CLOUDFLARE_TUNNEL_TOKEN"),
        ("mcp-gateway", "TUNNEL_TOKEN"),
        ("cloudflared", "CONNECTWISE_PRIVATE_KEY"),
        ("cloudflared", "JWT_SECRET_KEY"),
        ("cloudflared", "AZURE_CLIENT_SECRET"),
    ],
)
def test_rejects_cross_service_or_undeclared_secrets(service, secret):
    config = compose_config()
    config["services"][service]["environment"][secret] = "must-not-leak"

    with pytest.raises(ValueError, match="unexpected"):
        validate_compose_config(config)


def test_rejects_missing_required_gateway_variable():
    config = compose_config()
    del config["services"]["mcp-gateway"]["environment"]["MCP_STATIC_TOKEN"]

    with pytest.raises(ValueError, match="missing"):
        validate_compose_config(config)
