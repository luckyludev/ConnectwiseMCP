# Claude Setup (MCP Connector)

## Cloudflare Worker V2

Add the canonical Worker `/mcp` URL in Claude under **Customize → Connectors → Add custom connector**, then complete Microsoft Entra sign-in. Do not enter ConnectWise or Cloudflare secrets in Claude; the Worker resolves the authenticated identity's server-side `CW_PROFILE_<ALIAS>` secret.

The connector exposes bounded reads and writes. Entra controls who can reach the connector and selects the immutable profile mapping; the selected ConnectWise API member's Security Role is the final authority for every business operation. The retained `mcp:read` OAuth scope is server access, not a grant of ConnectWise write permission.

### Attach an image from chat

Ask Claude to “open the ConnectWise attachment uploader for ticket 123” or call `open_attachment_uploader` directly. The inline app lets the user:

- paste an image from the clipboard;
- drag and drop an image;
- choose a PNG, JPEG, GIF, or WebP file;
- select a Ticket or existing TimeEntry and choose internal/private or customer-visible attachment visibility;
- optionally create a ticket note after the ticket attachment succeeds.

Standard MCP tool arguments are JSON and do not automatically carry the original bytes of an image already attached to a chat message. Paste or drop that image into the inline uploader. Images over 1 MB are resized locally; the Worker independently enforces the 1 MB cap, validates MIME type, signature, extension, and fixed record type, never fetches an image URL, and never echoes image bytes into the result or audit log.

The attachment and optional ticket note are separate ConnectWise writes. If the attachment succeeds and the note fails, the app reports the document ID as partial success.

Follow the non-secret [V2 staging acceptance checklist](v2-staging-acceptance-checklist.md) before production onboarding.

## Legacy rollback gateway

> This remaining section configures the Docker/FastAPI rollback gateway, including its static bearer-token option. It is not the V2 deployment path.

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
