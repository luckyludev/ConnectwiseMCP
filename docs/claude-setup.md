# Claude Setup (MCP Connector)

This guide connects Claude to the ConnectwiseMCP HTTP gateway.

## Prerequisites

- Gateway running (see `README.md` Docker setup)
- `MCP_STATIC_TOKEN` set in `deploy/http-gateway/.env`
- Public URL: `https://connectwisemcp.funcshun.com`

## Option A: Token auth (fastest)

1) Open Claude → **Settings** → **Integrations / MCP** (wording may vary).
2) Add a new MCP server:
   - **Name:** `ConnectwiseMCP`
   - **Server URL:** `https://connectwisemcp.funcshun.com/sse`
   - **Auth:** Bearer token
   - **Token:** your `MCP_STATIC_TOKEN`
3) Save, then test with a prompt like:
   - “List the last 5 open ConnectWise tickets.”

## Option B: OAuth (Azure AD)

If you enabled OAuth on the gateway:

1) In Claude, add MCP server:
   - **Server URL:** `https://connectwisemcp.funcshun.com/sse`
   - **Auth:** OAuth
   - Leave Client ID/Secret blank (dynamic registration)
2) Complete the Azure AD login prompt.

## Notes

- For OAuth, ensure your Azure AD app includes:
  - `https://connectwisemcp.funcshun.com/oauth/callback`
- If you see `invalid_token`, verify `SERVER_URL` and `MCP_RESOURCE_URL` match the public URL.
