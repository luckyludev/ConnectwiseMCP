# ConnectwiseMCP

ConnectWise MCP server with an HTTP gateway and Cloudflare Tunnel.

## Structure

```
.
├── deploy/
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

## Docker setup (gateway + tunnel)

The Docker setup lives in `deploy/http-gateway/docker-compose.yml` and runs:
- `mcp-gateway` (FastAPI HTTP gateway)
- `cloudflared` (Cloudflare Tunnel)

Steps:

1) Copy env template and fill values:
```
cp deploy/http-gateway/.env.example deploy/http-gateway/.env
```

Required values:
- `MCP_STATIC_TOKEN` (strong random token)
- `JWT_SECRET_KEY` (required for OAuth tokens)
- `CONNECTWISE_*` variables
- `CLOUDFLARE_TUNNEL_TOKEN`

2) Build + run:
```
cd deploy/http-gateway
docker compose up -d --build
```

3) Verify:
```
curl http://127.0.0.1:8000/health
```

Notes:
- The gateway binds to `127.0.0.1:8000` and is only exposed publicly through Cloudflare.
- Ensure your Cloudflare Tunnel routes `connectwisemcp.funcshun.com` to this service.

## Quick start (token auth)

1) Test locally:
```
curl -H "Authorization: Bearer YOUR_TOKEN" http://127.0.0.1:8000/mcp
```

2) Test via Cloudflare:
```
curl -H "Authorization: Bearer YOUR_TOKEN" https://connectwisemcp.funcshun.com/mcp
```

## Copy/paste JSON-RPC examples

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
- Azure AD checklist: `docs/azure-ad-checklist.md`
- Troubleshooting: `docs/troubleshooting.md`

## Security notes

- Do not commit `.env` files.
- Rotate any credentials that were previously committed.

## Legacy

`deploy/supergateway` is kept for reference.
