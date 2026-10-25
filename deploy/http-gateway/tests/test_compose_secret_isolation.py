import pytest

from verify_compose_secret_isolation import (
    CANARY_VALUES,
    EXPECTED_GATEWAY_BUILD_CONTEXT,
    EXPECTED_GATEWAY_TMPFS,
    EXPECTED_LOGGING,
    GATEWAY_ENVIRONMENT,
    TUNNEL_ENVIRONMENT,
    validate_compose_config,
)


def compose_config() -> dict:
    return {
        "services": {
            "mcp-gateway": {
                "build": {
                    "context": str(EXPECTED_GATEWAY_BUILD_CONTEXT),
                    "dockerfile": "http-gateway/Dockerfile",
                },
                "command": None,
                "entrypoint": None,
                "environment": {name: f"gateway-{name}" for name in GATEWAY_ENVIRONMENT},
                "cap_drop": ["ALL"],
                "security_opt": ["no-new-privileges:true"],
                "read_only": True,
                "tmpfs": EXPECTED_GATEWAY_TMPFS.copy(),
                "logging": EXPECTED_LOGGING.copy() | {
                    "options": EXPECTED_LOGGING["options"].copy()
                },
                "networks": {"default": None},
                "ports": [
                    {
                        "mode": "ingress",
                        "target": 8000,
                        "published": "8000",
                        "protocol": "tcp",
                        "host_ip": "127.0.0.1",
                    }
                ],
            },
            "cloudflared": {
                "image": "cloudflare/cloudflared:latest@sha256:"
                + "a" * 64,
                "command": ["tunnel", "run"],
                "entrypoint": None,
                "environment": {name: f"tunnel-{name}" for name in TUNNEL_ENVIRONMENT},
                "cap_drop": ["ALL"],
                "security_opt": ["no-new-privileges:true"],
                "read_only": True,
                "logging": EXPECTED_LOGGING.copy() | {
                    "options": EXPECTED_LOGGING["options"].copy()
                },
                "networks": {"default": None},
                "depends_on": {
                    "mcp-gateway": {
                        "condition": "service_healthy",
                        "required": True,
                    }
                },
            },
        },
        "networks": {
            "default": {"ipam": {}, "name": "http-gateway_default"}
        },
    }


def test_accepts_exact_service_environment_allowlists():
    validate_compose_config(compose_config())


@pytest.mark.parametrize("service", ["mcp-gateway", "cloudflared"])
@pytest.mark.parametrize(
    "logging",
    [
        None,
        {},
        {"driver": "local", "options": {"max-size": "10m", "max-file": "3"}},
        {"driver": "json-file"},
        {"driver": "json-file", "options": {"max-file": "3"}},
        {
            "driver": "json-file",
            "options": {"max-size": "0", "max-file": "3"},
        },
        {
            "driver": "json-file",
            "options": {"max-size": "10m", "max-file": "0"},
        },
        {
            "driver": "json-file",
            "options": {"max-size": "10m", "max-file": "3", "labels": "*"},
        },
    ],
)
def test_rejects_missing_unbounded_or_altered_logging(service, logging):
    config = compose_config()
    if logging is None:
        del config["services"][service]["logging"]
    else:
        config["services"][service]["logging"] = logging

    with pytest.raises(ValueError, match="logging must use json-file"):
        validate_compose_config(config)


def test_rejects_unreviewed_additional_service():
    config = compose_config()
    config["services"]["unreviewed-sidecar"] = {
        "image": "example.invalid/unreviewed:latest",
        "privileged": True,
        "network_mode": "host",
        "environment": {"CONNECTWISE_PRIVATE_KEY": "must-not-leak"},
    }

    with pytest.raises(ValueError, match="rollback allowlist.*unreviewed-sidecar"):
        validate_compose_config(config)


@pytest.mark.parametrize("service", ["mcp-gateway", "cloudflared"])
@pytest.mark.parametrize(
    ("field", "value", "error"),
    [
        ("cap_drop", None, "drop all Linux capabilities"),
        ("cap_drop", [], "drop all Linux capabilities"),
        ("cap_drop", ["NET_RAW"], "drop all Linux capabilities"),
        ("cap_drop", ["ALL", "NET_RAW"], "drop all Linux capabilities"),
        ("security_opt", None, "forbid privilege acquisition"),
        ("security_opt", [], "forbid privilege acquisition"),
        ("security_opt", ["no-new-privileges:false"], "forbid privilege acquisition"),
        (
            "security_opt",
            ["no-new-privileges:true", "label=disable"],
            "forbid privilege acquisition",
        ),
    ],
)
def test_rejects_permissive_or_non_allowlisted_runtime_settings(
    service, field, value, error
):
    config = compose_config()
    config["services"][service][field] = value

    with pytest.raises(ValueError, match=error):
        validate_compose_config(config)


@pytest.mark.parametrize("service", ["mcp-gateway", "cloudflared"])
@pytest.mark.parametrize("read_only", [None, False, "true", 1])
def test_rejects_writable_or_non_boolean_root_filesystem(service, read_only):
    config = compose_config()
    if read_only is None:
        del config["services"][service]["read_only"]
    else:
        config["services"][service]["read_only"] = read_only

    with pytest.raises(ValueError, match="root filesystem must be read-only"):
        validate_compose_config(config)


@pytest.mark.parametrize(
    "tmpfs",
    [
        None,
        [],
        ["/run/connectwise-memory"],
        ["/run/connectwise-memory:rw,size=32m,uid=10001,gid=10001,mode=0700"],
        ["/run/connectwise-memory:rw,noexec,nosuid,nodev,size=16m,uid=0,gid=0,mode=0777"],
        EXPECTED_GATEWAY_TMPFS + ["/tmp:size=16m"],
    ],
)
def test_rejects_missing_unbounded_or_altered_fast_memory_tmpfs(tmpfs):
    config = compose_config()
    if tmpfs is None:
        del config["services"]["mcp-gateway"]["tmpfs"]
    else:
        config["services"]["mcp-gateway"]["tmpfs"] = tmpfs

    with pytest.raises(ValueError, match="bounded, restricted Fast Memory tmpfs"):
        validate_compose_config(config)


def test_rejects_cloudflared_tmpfs():
    config = compose_config()
    config["services"]["cloudflared"]["tmpfs"] = ["/tmp:size=16m"]

    with pytest.raises(ValueError, match="non-allowlisted service fields: tmpfs"):
        validate_compose_config(config)


@pytest.mark.parametrize("service", ["mcp-gateway", "cloudflared"])
def test_rejects_host_networking(service):
    config = compose_config()
    config["services"][service]["network_mode"] = "host"

    with pytest.raises(ValueError, match="must not use host networking"):
        validate_compose_config(config)


@pytest.mark.parametrize("service", ["mcp-gateway", "cloudflared"])
@pytest.mark.parametrize(
    ("field", "value", "error"),
    [
        ("privileged", True, "must not run in privileged mode"),
        ("cap_add", ["SYS_ADMIN"], "must not add Linux capabilities"),
        ("pid", "host", "must not share a PID namespace"),
        ("pid", "service:mcp-gateway", "must not share a PID namespace"),
        ("ipc", "host", "must not share an IPC namespace"),
        ("ipc", "shareable", "must not share an IPC namespace"),
        (
            "volumes",
            [{"type": "bind", "source": "/", "target": "/host"}],
            "must not mount host or named volumes",
        ),
        (
            "volumes",
            [{"type": "volume", "source": "shared", "target": "/shared"}],
            "must not mount host or named volumes",
        ),
        (
            "devices",
            [{"source": "/dev/kvm", "target": "/dev/kvm", "permissions": "rwm"}],
            "must not access host devices",
        ),
        (
            "pre_start",
            [
                {
                    "command": ["sh", "-c", "true"],
                    "privileged": True,
                    "user": "root",
                }
            ],
            "must not define lifecycle containers",
        ),
        (
            "post_start",
            [{"command": ["sh", "-c", "true"]}],
            "must not define lifecycle containers",
        ),
        (
            "pre_stop",
            [{"command": ["sh", "-c", "true"]}],
            "must not define lifecycle containers",
        ),
        (
            "use_api_socket",
            True,
            "must not access the container engine API socket",
        ),
        (
            "volumes_from",
            ["container:host-helper"],
            "must not inherit another container's volumes",
        ),
        ("gpus", "all", "must not access host GPUs"),
        (
            "deploy",
            {
                "resources": {
                    "reservations": {
                        "devices": [{"capabilities": ["gpu"], "count": -1}]
                    }
                }
            },
            "must not define deployment-level runtime access",
        ),
    ],
)
def test_rejects_host_access_and_namespace_overrides(service, field, value, error):
    config = compose_config()
    config["services"][service][field] = value

    with pytest.raises(ValueError, match=error):
        validate_compose_config(config)


@pytest.mark.parametrize("service", ["mcp-gateway", "cloudflared"])
def test_rejects_every_non_allowlisted_service_field(service):
    config = compose_config()
    config["services"][service]["future_compose_escape_hatch"] = True

    with pytest.raises(ValueError, match="non-allowlisted service fields"):
        validate_compose_config(config)


def test_rejects_gateway_command_or_entrypoint_override():
    for field in ("command", "entrypoint"):
        config = compose_config()
        config["services"]["mcp-gateway"][field] = ["sh", "-c", "true"]

        with pytest.raises(ValueError, match="must come from its image"):
            validate_compose_config(config)


@pytest.mark.parametrize(
    "build",
    [
        {
            "context": str(EXPECTED_GATEWAY_BUILD_CONTEXT),
            "dockerfile": "http-gateway/Dockerfile",
            "network": "host",
        },
        {
            "context": "/tmp/unreviewed-build-context",
            "dockerfile": "http-gateway/Dockerfile",
        },
        {
            "context": str(EXPECTED_GATEWAY_BUILD_CONTEXT),
            "dockerfile": "unreviewed.Dockerfile",
        },
    ],
)
def test_rejects_unreviewed_gateway_build_controls(build):
    config = compose_config()
    config["services"]["mcp-gateway"]["build"] = build

    with pytest.raises(ValueError, match="build|Dockerfile"):
        validate_compose_config(config)


def test_rejects_cloudflared_command_or_entrypoint_override():
    config = compose_config()
    config["services"]["cloudflared"]["command"] = ["proxy-dns"]
    with pytest.raises(ValueError, match="command must be exactly"):
        validate_compose_config(config)

    config = compose_config()
    config["services"]["cloudflared"]["entrypoint"] = ["sh"]
    with pytest.raises(ValueError, match="entrypoint must come from"):
        validate_compose_config(config)


@pytest.mark.parametrize("service", ["mcp-gateway", "cloudflared"])
def test_rejects_alternate_service_network_attachments(service):
    config = compose_config()
    config["services"][service]["networks"] = {"hostnet": None}
    config["networks"] = {"hostnet": {"external": True, "name": "host"}}

    with pytest.raises(ValueError, match="attach only to the default"):
        validate_compose_config(config)


@pytest.mark.parametrize(
    "networks",
    [
        {"default": {"external": True, "name": "host"}},
        {"default": {"ipam": {}, "name": "host"}},
        {"default": {"ipam": {}, "name": "none"}},
        {"default": {"ipam": {}, "name": "bridge"}},
        {
            "default": {
                "ipam": {"config": [{"subnet": "169.254.0.0/16"}]},
                "name": "http-gateway_default",
            }
        },
        {"default": {"driver": "host", "name": "unsafe"}},
        {
            "default": {"name": "http-gateway_default"},
            "extra": {"name": "unexpected"},
        },
    ],
)
def test_rejects_external_host_or_nondefault_network_definitions(networks):
    config = compose_config()
    config["networks"] = networks

    with pytest.raises(ValueError, match="default.*network|network name"):
        validate_compose_config(config)


@pytest.mark.parametrize(
    "ports",
    [
        None,
        [],
        [
            {
                "mode": "ingress",
                "target": 8000,
                "published": "8000",
                "protocol": "tcp",
            }
        ],
        [
            {
                "mode": "ingress",
                "target": 8000,
                "published": "8000",
                "protocol": "tcp",
                "host_ip": "0.0.0.0",
            }
        ],
        [
            {
                "mode": "ingress",
                "target": 8000,
                "published": "8000",
                "protocol": "tcp",
                "host_ip": "::",
            }
        ],
        [
            {
                "mode": "ingress",
                "target": 8001,
                "published": "8000",
                "protocol": "tcp",
                "host_ip": "127.0.0.1",
            }
        ],
        [
            {
                "mode": "ingress",
                "target": 8000,
                "published": "8001",
                "protocol": "tcp",
                "host_ip": "127.0.0.1",
            }
        ],
        [
            {
                "mode": "ingress",
                "target": 8000,
                "published": "8000",
                "protocol": "udp",
                "host_ip": "127.0.0.1",
            }
        ],
        [
            {
                "mode": "host",
                "target": 8000,
                "published": "8000",
                "protocol": "tcp",
                "host_ip": "127.0.0.1",
            }
        ],
        [
            {
                "mode": "ingress",
                "target": 8000,
                "published": "8000",
                "protocol": "tcp",
                "host_ip": "127.0.0.1",
            },
            {
                "mode": "ingress",
                "target": 9000,
                "published": "9000",
                "protocol": "tcp",
                "host_ip": "127.0.0.1",
            },
        ],
    ],
)
def test_rejects_non_loopback_or_extra_gateway_ports(ports):
    config = compose_config()
    if ports is None:
        del config["services"]["mcp-gateway"]["ports"]
    else:
        config["services"]["mcp-gateway"]["ports"] = ports

    with pytest.raises(ValueError, match="publish only TCP port 8000"):
        validate_compose_config(config)


def test_rejects_published_cloudflared_ports():
    config = compose_config()
    config["services"]["cloudflared"]["ports"] = [
        {
            "mode": "ingress",
            "target": 7844,
            "published": "7844",
            "protocol": "tcp",
            "host_ip": "127.0.0.1",
        }
    ]

    with pytest.raises(ValueError, match="cloudflared must not publish host ports"):
        validate_compose_config(config)


@pytest.mark.parametrize(
    "image",
    [
        None,
        "cloudflare/cloudflared:latest",
        "cloudflare/cloudflared@sha256:" + "a" * 64,
        "cloudflare/cloudflared:latest@sha256:" + "A" * 64,
        "cloudflare/cloudflared:latest@sha256:" + "a" * 63,
        "example.invalid/cloudflared:latest@sha256:" + "a" * 64,
    ],
)
def test_rejects_unpinned_or_unofficial_cloudflared_image(image):
    config = compose_config()
    if image is None:
        del config["services"]["cloudflared"]["image"]
    else:
        config["services"]["cloudflared"]["image"] = image

    with pytest.raises(ValueError, match="cloudflared image must"):
        validate_compose_config(config)


@pytest.mark.parametrize(
    "depends_on",
    [
        None,
        {},
        {"mcp-gateway": {"condition": "service_started"}},
        {
            "mcp-gateway": {
                "condition": "service_healthy",
                "required": False,
            }
        },
        {
            "mcp-gateway": {
                "condition": "service_healthy",
                "required": "true",
            }
        },
        {"wrong-service": {"condition": "service_healthy"}},
        {
            "mcp-gateway": {"condition": "service_healthy"},
            "wrong-service": {"condition": "service_healthy"},
        },
    ],
)
def test_rejects_tunnel_startup_without_exact_gateway_health_dependency(depends_on):
    config = compose_config()
    if depends_on is None:
        del config["services"]["cloudflared"]["depends_on"]
    else:
        config["services"]["cloudflared"]["depends_on"] = depends_on

    with pytest.raises(ValueError, match="cloudflared must"):
        validate_compose_config(config)


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
