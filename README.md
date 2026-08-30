# ConnectwiseMCP

ConnectWise MCP server migrating from the legacy Docker/FastAPI gateway to a secure Cloudflare Worker v2.

> **Migration status:** v2 is implemented in `src/` with Entra OAuth, rotating refresh, immutable identity mapping, structured sanitized tool audit events, and a bounded purpose-built ConnectWise business catalog. Every invocation resolves exactly one `CW_PROFILE_<ALIAS>` Worker secret, requires its origin in `CONNECTWISE_ALLOWED_ORIGINS`, rejects redirects, and creates a fresh request-scoped client. The mapped user's ConnectWise API-member Security Role remains the final authority for both reads and writes. Generic raw API/debug tools remain excluded. Document downloads are capped at 8 MB; image uploads use an inline MCP App, client-side resizing, a 1 MB server cap, fixed Ticket/TimeEntry targets, MIME-signature verification, and non-retried multipart writes. The legacy deployment under `deploy/` remains available for rollback until v2 passes staging, isolation, observability, and rollback acceptance. See [`docs/v2-foundation.md`](docs/v2-foundation.md).

## Structure

```
.
├── src/                       # Cloudflare Worker v2 foundation
├── tests/                     # v2 security and OAuth tests
├── ui/                        # bundled inline MCP attachment uploader
├── scripts/                   # staging smoke and deterministic UI embedding
├── package.json               # exact v2 dependency versions and checks
├── wrangler.jsonc             # non-secret Worker configuration
├── deploy/                    # legacy Docker/FastAPI rollback path
│   ├── cwm-mcp/              # Core MCP tools (ConnectWise API gateway)
│   ├── http-gateway/         # HTTP gateway (OAuth + token auth)
│   └── supergateway/         # Legacy/optional
├── docs/
│   ├── README.md             # Docs index
│   ├── chatgpt-connector.md  # ChatGPT connector setup
│   ├── claude-setup.md       # Claude MCP setup
│   ├── azure-ad-checklist.md # Azure AD setup checklist
│   ├── troubleshooting.md    # Common issues and checks
│   └── n8n-setup.md           # n8n setup
└── README.md
```

## Architecture

> See the [proposed Cloudflare Worker v2 architecture](docs/architecture.md) and [standalone HTML visual](docs/architecture.html). The diagram below describes the current Docker deployment.

```
┌──────────────────────────┐    HTTPS    ┌──────────────────────┐    HTTP    ┌──────────────────────┐
│ MCP Clients              │────────────▶│ Cloudflare Tunnel     │──────────▶│ HTTP Gateway (FastAPI)│
│ (ChatGPT / Claude / etc) │             │ connectwisemcp...     │           │ - OAuth 2.1 + PKCE    │
└──────────────────────────┘             └──────────────────────┘           │ - DCR endpoints       │
                                                                            │ - Azure AD login      │
                                                                            │ - /mcp + /sse         │
                                                                            └───────────┬──────────┘
                                                                                        │
                                                                                        ▼
                                                                            ┌──────────────────────┐
                                                                            │ MCP Tools (cwm-mcp)  │
                                                                            │ ConnectWise API      │
                                                                            └──────────────────────┘
```

## Legacy rollback safety boundary

The Docker/FastAPI gateway under `deploy/` is retained only as a controlled emergency rollback path while Worker v2 completes live acceptance. Its OAuth boundary is hardened to:

- return a generated client secret only once during bounded dynamic registration;
- cap registration bodies at 16 KiB, redirect lists at 10 entries, individual redirects at 2,048 characters, names at 128 characters, caller state at 512 characters, Azure subject IDs at 256 characters, and each process-local client/auth-request/auth-code store at 1,000 entries;
- expire newly registered clients after 24 hours and evict expired entries before admitting more registrations;
- expose no unauthenticated client-registration readback or management URI;
- reject unknown clients instead of authorization-time auto-provisioning;
- allow only `client_secret_post`, authorization-code grants, `code` responses, bounded allowlisted scopes, and S256 PKCE;
- require strict absolute HTTPS callback URIs and literal redirect/resource binding;
- consume callback state and authorization codes once;
- sanitize upstream OAuth failures and Azure verification logs;
- require signed RS256 Entra tokens with exact issuer/audience, mandatory `exp`/`iat`, time validation, and rate-limited JWKS refresh on key rotation;
- require at least 32 ASCII bytes for the local JWT signing secret and static bearer token.

It still has material legacy limitations:

- dynamic registration remains unauthenticated, has no redirect allowlist or application-level rate limit, and therefore requires perimeter access control;
- clients, callback state, and authorization codes are process-local; client registrations expire after 24 hours, and all state disappears on restart;
- locally issued access tokens expire after one hour and the gateway has no refresh-token grant;
- one deployment-wide ConnectWise credential set and static bearer token remain available;
- OAuth scope claims do not provide per-tool authorization;
- it does not provide Worker v2's immutable six-user identity mapping, request-scoped profile secrets, narrow tool authorization, or structured audit model;
- broad legacy MCP tools remain present.

Do not treat this gateway as the production target or leave it generally exposed after v2 cutover. Any rollback must be time-bounded, access-controlled, monitored, and reversed after the incident. Never commit `.env` or registration responses, and never copy real client, Entra, ConnectWise, Cloudflare, or JWT secrets into logs or issue reports.

## Docker setup (gateway + tunnel)

The Docker setup lives in `deploy/http-gateway/docker-compose.yml` and runs:

- `mcp-gateway` (FastAPI HTTP gateway)
- `cloudflared` (Cloudflare Tunnel)

Steps:

1. Copy env template and fill values:

```
cp deploy/http-gateway/.env.example deploy/http-gateway/.env
```

Required values:

- `MCP_STATIC_TOKEN` (strong random token)
- `JWT_SECRET_KEY` (required for OAuth tokens)
- `CONNECTWISE_*` variables
- `CLOUDFLARE_TUNNEL_TOKEN`

2. Build + run:

```
cd deploy/http-gateway
docker compose up -d --build
```

3. Verify:

```
curl http://127.0.0.1:8000/health
```

Notes:

- The gateway binds to `127.0.0.1:8000` and is only exposed publicly through Cloudflare.
- Ensure your Cloudflare Tunnel routes `connectwisemcp.funcshun.com` to this service.

## Local macOS install (Homebrew + Docker)

Use this if you want to run the MCP gateway locally and connect Claude to `127.0.0.1`.

1. Install Homebrew + tooling:

```
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install git
brew install --cask docker
```

Open **Docker Desktop** once and wait for it to finish starting.

2. Clone the repo:

```
git clone https://github.com/luckyludev/ConnectwiseMCP.git
cd ConnectwiseMCP
```

3. Configure local env:

```
cp deploy/http-gateway/.env.example deploy/http-gateway/.env
```

Edit `deploy/http-gateway/.env` and set:

- `MCP_STATIC_TOKEN` (strong random token)
- `JWT_SECRET_KEY` (strong random secret)
- `CONNECTWISE_*` values
- `SERVER_URL=http://127.0.0.1:8000`
- `MCP_RESOURCE_URL=http://127.0.0.1:8000`

4. Start the local gateway (Docker):

```
cd deploy/http-gateway
docker compose up -d --build mcp-gateway
```

Verify:

```
curl http://127.0.0.1:8000/health
```

5. Add the local MCP server in Claude:

- **Name:** `ConnectwiseMCP (Local)`
- **Server URL:** `http://127.0.0.1:8000/sse`
- **Auth:** Bearer token
- **Token:** your `MCP_STATIC_TOKEN`

> If you want the Cloudflare tunnel too, set `CLOUDFLARE_TUNNEL_TOKEN` and run `docker compose up -d --build` without the service name.

## Quick start (token auth)

1. Test locally:

```
curl -H "Authorization: Bearer YOUR_TOKEN" http://127.0.0.1:8000/mcp
```

2. Test via Cloudflare:

```
curl -H "Authorization: Bearer YOUR_TOKEN" https://connectwisemcp.funcshun.com/mcp
```

## Legacy-only JSON-RPC example

> This request targets the broad Docker/FastAPI rollback surface and is **not** a Worker V2 capability or recommendation. Worker V2 intentionally does not expose generic API discovery tools such as `search_api_endpoints`; see [`docs/legacy-read-surface-classification.md`](docs/legacy-read-surface-classification.md).

List tools:

```
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/list",
  "params": {}
}
```

Call a tool:

```
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "search_api_endpoints",
    "arguments": {
      "query": "tickets",
      "max_results": 5
    }
  }
}
```

## OAuth + client guides

- ChatGPT: `docs/chatgpt-connector.md`
- Claude: `docs/claude-setup.md`
- n8n: `docs/n8n-setup.md`
- Copilot Studio + Azure: `docs/copilot-studio-azure.md`
- Azure AD checklist: `docs/azure-ad-checklist.md`
- Troubleshooting: `docs/troubleshooting.md`

## Security notes

- Do not commit `.env` files.
- Rotate any credentials that were previously committed.

## Legacy

`deploy/supergateway` is kept for reference.
