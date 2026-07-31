# Claude Setup (MCP Connector) — legacy rollback gateway

> **Legacy-only:** this guide configures the Docker/FastAPI rollback gateway, including its static bearer-token option. It is not a Cloudflare Worker V2 setup guide and must not be used for V2 deployment or client onboarding. Follow the non-secret [V2 staging acceptance checklist](v2-staging-acceptance-checklist.md) with authorized operators before any V2 client configuration.

This guide connects Claude to the ConnectwiseMCP HTTP gateway.

## Prerequisites

- Gateway running (see `README.md` Docker setup)
- `MCP_STATIC_TOKEN` set in `deploy/http-gateway/.env`
- Public URL: `https://connectwisemcp.funcshun.com`

## Local macOS install (Homebrew + Docker)

Use this if you want Claude to connect to a local MCP server on `127.0.0.1`.

### 1) Install Homebrew + tooling

```
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install git
brew install --cask docker
```

Open **Docker Desktop** once and wait for it to finish starting.

### 2) Clone the repo

```
git clone https://github.com/luckyludev/ConnectwiseMCP.git
cd ConnectwiseMCP
```

### 3) Configure local env

```
cp deploy/http-gateway/.env.example deploy/http-gateway/.env
```

Edit `deploy/http-gateway/.env` and set:

- `MCP_STATIC_TOKEN` (strong random token)
- `JWT_SECRET_KEY` (strong random secret)
- `CONNECTWISE_*` values
- `SERVER_URL=http://127.0.0.1:8000`
- `MCP_RESOURCE_URL=http://127.0.0.1:8000`

### 4) Start the local gateway (Docker)

```
cd deploy/http-gateway
docker compose up -d --build mcp-gateway
```

Verify:

```
curl http://127.0.0.1:8000/health
```

> If you want the Cloudflare tunnel too, set `CLOUDFLARE_TUNNEL_TOKEN` and run `docker compose up -d --build` without the service name.

### 5) Add the local MCP server in Claude

In Claude → **Settings** → **Integrations / MCP**:

- **Name:** `ConnectwiseMCP (Local)`
- **Server URL:** `http://127.0.0.1:8000/sse`
- **Auth:** Bearer token
- **Token:** your `MCP_STATIC_TOKEN`

## Option A: Token auth (fastest)

1. Open Claude → **Settings** → **Integrations / MCP** (wording may vary).
2. Add a new MCP server:
   - **Name:** `ConnectwiseMCP`
   - **Server URL:** `https://connectwisemcp.funcshun.com/sse`
   - **Auth:** Bearer token
   - **Token:** your `MCP_STATIC_TOKEN`
3. Save, then test with a prompt like:
   - “List the last 5 open ConnectWise tickets.”

## Option B: OAuth (Azure AD)

If you enabled OAuth on the gateway:

1. In Claude, add MCP server:
   - **Server URL:** `https://connectwisemcp.funcshun.com/sse`
   - **Auth:** OAuth
   - Leave Client ID/Secret blank (dynamic registration)
2. Complete the Azure AD login prompt.

## Known-good Claude connector config

- **Name:** `ConnectwiseMCP`
- **Server URL:** `https://connectwisemcp.funcshun.com/sse`
- **Auth:** OAuth (or Bearer token)
- **Token:** (only required for Bearer token)

## Notes

- For OAuth, ensure your Azure AD app includes:
  - `https://connectwisemcp.funcshun.com/oauth/callback`
- If you see `invalid_token`, verify `SERVER_URL` and `MCP_RESOURCE_URL` match the public URL.
