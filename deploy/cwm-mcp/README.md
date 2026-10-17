# Legacy ConnectWise MCP core

> **Rollback-only component:** this directory is retained only as part of the legacy Docker/FastAPI emergency rollback path. It is not the production target, must not be installed or exposed as a standalone MCP server, and must not be connected directly to an MCP client. The code includes broad discovery, raw-request, and shared-credential capabilities that are intentionally excluded from Worker V2.

Use the repository's reviewed, CI-built rollback image only. Do not install this package globally, install it directly from another repository, run its stdio or streamable-HTTP entry points, or place ConnectWise credentials in desktop/client configuration.

## Supported use

- Production and staging use the Cloudflare Worker V2 implementation in `src/`.
- The only supported legacy deployment unit is the Docker/FastAPI gateway in `deploy/http-gateway/`.
- Emergency rollback must use the exact artifact from a successful canonical `main` `legacy-oauth-ci` run.
- Keep rollback access private, time-bounded, monitored, and protected by the perimeter controls described in the runbook.
- Keep all ConnectWise, Entra, JWT, bearer-token, and client credentials out of source, logs, issue reports, and MCP client configuration.

Follow [`docs/cutover-rollback-runbook.md`](../../docs/cutover-rollback-runbook.md) for artifact verification, activation, validation, and reversal. For local gateway development, use the constrained instructions in the [repository README](../../README.md#local-development-docker-setup-gateway-only); do not attach a tunnel or public route.

## Maintenance boundary

The Python sources and metadata remain solely so the reviewed rollback image can be rebuilt and audited. Dependency changes start in `deploy/cwm-mcp/requirements.txt`, require regeneration of `deploy/http-gateway/requirements.lock`, and must pass `legacy-oauth-ci`. Do not add new capabilities here or migrate its generic API execution surface into Worker V2.
