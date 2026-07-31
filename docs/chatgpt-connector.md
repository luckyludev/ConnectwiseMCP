# ChatGPT Connector Setup (OAuth) — legacy rollback gateway

> **Legacy-only:** this guide configures the Docker/FastAPI rollback gateway, not the Cloudflare Worker V2. It must not be used to deploy, configure, or represent the V2 production path. Worker V2 client onboarding remains human-gated until the non-secret [staging acceptance checklist](v2-staging-acceptance-checklist.md) has passed. The V2 read-surface boundary is documented in [the migration classification](legacy-read-surface-classification.md).

This guide configures the ConnectwiseMCP HTTP gateway for ChatGPT (and other MCP clients)
that require OAuth 2.1 + Dynamic Client Registration (DCR).

If you follow this top-to-bottom, you should be able to:

- Connect the server in ChatGPT.
- Complete OAuth login successfully.
- See MCP tools from ConnectwiseMCP.

---

## 0) Pre-flight checklist (do this first)

Before configuring ChatGPT, confirm the gateway is reachable at your public URL and that
you know the values below:

- Public base URL (example: `https://connectwisemcp.funcshun.com`)
- Azure Entra tenant/client/secret
- ConnectWise API credentials
- Cloudflare tunnel token

Quick checks (replace domain as needed):

```bash
curl -i https://connectwisemcp.funcshun.com/health
curl -i https://connectwisemcp.funcshun.com/.well-known/oauth-protected-resource
curl -i https://connectwisemcp.funcshun.com/.well-known/oauth-authorization-server
```

Expected:

- `/health` returns `200`.
- Both `/.well-known/*` endpoints return `200` JSON.

## 1) Prepare Azure AD (Entra) App Registration

Create an **App Registration** for the gateway server (confidential client).

Required values:

- **Tenant ID**
- **Client ID**
- **Client Secret**

Redirect URIs (**Web**):

- `https://connectwisemcp.funcshun.com/oauth/callback`
- `https://chatgpt.com/connector_platform_oauth_redirect`
- `https://platform.openai.com/apps-manage/oauth`

Scopes:

- `openid profile email`

Important Azure settings:

- Platform type must be **Web** (not SPA).
- Generate and store a **Client Secret**.
- Token configuration should include standard OpenID scopes.

## 2) Configure the gateway

Copy the env template and fill values:

```
cp deploy/http-gateway/.env.example deploy/http-gateway/.env
```

Set:

- `SERVER_URL=https://connectwisemcp.funcshun.com`
- `MCP_RESOURCE_URL=https://connectwisemcp.funcshun.com`
- `JWT_SECRET_KEY` (random secret)
- `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`
- ConnectWise credentials
- `CLOUDFLARE_TUNNEL_TOKEN`

Notes:

- `SERVER_URL` and `MCP_RESOURCE_URL` should exactly match your public URL
  (scheme + host, no trailing path).
- `JWT_SECRET_KEY` should be long and random.

Start the stack:

```
cd deploy/http-gateway
docker compose up -d --build
```

## 3) Verify discovery endpoints

```
curl https://connectwisemcp.funcshun.com/.well-known/oauth-protected-resource
curl https://connectwisemcp.funcshun.com/.well-known/oauth-authorization-server
```

Optional detailed checks:

```bash
curl -s https://connectwisemcp.funcshun.com/.well-known/oauth-protected-resource | jq
curl -s https://connectwisemcp.funcshun.com/.well-known/oauth-authorization-server | jq
```

Confirm that URLs and issuer/resource fields reference your public domain.

## 4) Add the MCP Connector in ChatGPT

In ChatGPT:

- **MCP Server URL:** `https://connectwisemcp.funcshun.com/sse`
- **Authentication:** OAuth
- Leave Client ID/Secret blank (dynamic registration)

Complete the OAuth login when prompted.

If ChatGPT asks to authorize access, approve it and wait for connector setup to finish.
If setup stalls, see troubleshooting below.

## Known-good ChatGPT connector config

Use these values in the ChatGPT connector form:

- **Name:** `ConnectwiseMCP`
- **MCP Server URL:** `https://connectwisemcp.funcshun.com/sse`
- **Auth Type:** OAuth
- **Client ID / Secret:** leave empty (dynamic registration)

---

## 5) Validate end-to-end in ChatGPT

After adding the connector, run a simple prompt first:

- `List available tools from ConnectwiseMCP.`

Then run a business prompt:

- `List the last 5 open ConnectWise tickets.`

If tools are missing, restart the connector session in ChatGPT and retry.

## Troubleshooting

- **401 or invalid_token**
  - Check `SERVER_URL` and `MCP_RESOURCE_URL` match the public URL.
  - Confirm the Cloudflare tunnel is pointing to the gateway.

- **OAuth redirect errors**
  - Ensure all redirect URIs are present in Azure AD.
  - Make sure you created a client secret (not just certificate).

- **Azure token exchange fails**
  - Verify `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` are correct.
  - Check the Azure app is set as a **Web** app.

- **MCP tools not appearing**
  - Check gateway logs for tool registration.
  - Confirm ConnectWise env vars are valid.

- **`invalid_redirect_uri` in Azure**
  - Recheck the exact redirect URI values in Azure App Registration.
  - Confirm there are no typos, trailing slashes, or wrong domain.

- **DCR/client registration issues**
  - Verify `/.well-known/oauth-authorization-server` is publicly reachable.
  - Ensure ChatGPT connector is set to OAuth with client fields blank.

Useful log command:

```bash
cd deploy/http-gateway
docker compose logs -f mcp-gateway
```

You should see OAuth/discovery requests when ChatGPT attempts to connect.

## Notes

- The gateway uses Azure AD for user login, then issues a local OAuth access token
  (HS256) for MCP access.
- Resource URL must match what ChatGPT sends as the `resource` parameter.
