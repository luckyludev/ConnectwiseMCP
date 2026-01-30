# ChatGPT Connector Setup (OAuth)

This guide configures the ConnectwiseMCP HTTP gateway for ChatGPT/other MCP clients
that require OAuth 2.1 + dynamic client registration.

## 1) Prepare Azure AD (Entra) App Registration

Create an **App Registration** for the gateway server (confidential client).

Required values:
- **Tenant ID**
- **Client ID**
- **Client Secret**

Redirect URIs (Web):
- `https://connectwisemcp.funcshun.com/oauth/callback`
- `https://chatgpt.com/connector_platform_oauth_redirect`
- `https://platform.openai.com/apps-manage/oauth`

Scopes:
- `openid profile email` (default)

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

## 4) Add the MCP Connector in ChatGPT

In ChatGPT:
- **MCP Server URL:** `https://connectwisemcp.funcshun.com/sse`
- **Authentication:** OAuth
- Leave Client ID/Secret blank (dynamic registration)

Complete the OAuth login when prompted.

## 5) Test

From ChatGPT, try:
"List the last 5 open ConnectWise tickets"

## Notes

- The gateway uses Azure AD for user login, then issues a local OAuth access token
  (HS256) for MCP access.
- Resource URL must match what ChatGPT sends as the `resource` parameter.
