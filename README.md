# ConnectwiseMCP

ConnectWise MCP server with an HTTP gateway and Cloudflare Tunnel.

This repo includes:
- `deploy/cwm-mcp`: MCP tools + ConnectWise API gateway (Python + FastMCP)
- `deploy/http-gateway`: HTTP gateway with static bearer token auth (SSO-ready)
- `deploy/supergateway`: Legacy supergateway container (optional)

## Quick start (token auth + Cloudflare Tunnel)

1) Copy env template and fill values:
```
cp deploy/http-gateway/.env.example deploy/http-gateway/.env
```

Required values:
- `MCP_STATIC_TOKEN` (strong random token)
- `CONNECTWISE_*` variables
- `CLOUDFLARE_TUNNEL_TOKEN`

2) Build + run:
```
cd deploy/http-gateway
docker compose up -d --build
```

3) Test locally:
```
curl -H "Authorization: Bearer YOUR_TOKEN" http://127.0.0.1:8000/mcp
```

4) Test via Cloudflare:
```
curl -H "Authorization: Bearer YOUR_TOKEN" https://connectwisemcp.funcshun.com/mcp
```

## SSO (Azure AD) - optional

The gateway can validate Azure AD access tokens if you set:
- `AZURE_TENANT_ID`
- `AZURE_CLIENT_ID` or `AZURE_AUDIENCE`

This repo does **not** include the OAuth server endpoints yet (dynamic client registration, /oauth/*). If you need ChatGPT OAuth flow, we can add them later.

## Security notes

- Do not commit `.env` files.
- Rotate any credentials that were previously committed.

## Legacy

`deploy/supergateway` is kept for reference.
