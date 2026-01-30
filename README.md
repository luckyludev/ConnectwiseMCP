# ConnectwiseMCP

ConnectWise MCP server with an HTTP gateway and Cloudflare Tunnel.

## Structure

```
.
├── deploy/
│   ├── cwm-mcp/              # Core MCP tools (ConnectWise API gateway)
│   ├── http-gateway/         # HTTP gateway (token auth + Azure AD JWT)
│   └── supergateway/         # Legacy/optional
├── docs/
│   └── oauth-cloudflare/     # OAuth + Cloudflare guidance (from Claude files)
└── README.md
```

## Architecture (current)

```
┌───────────────┐       ┌────────────────────┐       ┌───────────────────────┐
│ MCP Clients   │──────▶│ Cloudflare Tunnel  │──────▶│ HTTP Gateway (FastAPI) │
│ (ChatGPT/etc) │ HTTPS │ connectwisemcp...  │ HTTPS │  - Token auth          │
└───────────────┘       └────────────────────┘       │  - Azure AD JWT (opt)  │
                                                     │  - /mcp + /sse         │
                                                     └───────────────┬───────┘
                                                                     │
                                                                     ▼
                                                         ┌────────────────────┐
                                                         │ MCP Tools (cwm-mcp)│
                                                         │ ConnectWise API     │
                                                         └────────────────────┘
```

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

OAuth endpoints (dynamic client registration, /oauth/*) are **not** implemented yet.
See `docs/oauth-cloudflare` for the reference implementation.

## Security notes

- Do not commit `.env` files.
- Rotate any credentials that were previously committed.

## Legacy

`deploy/supergateway` is kept for reference.
