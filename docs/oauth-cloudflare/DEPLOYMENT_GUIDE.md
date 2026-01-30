# MCP Server with OAuth 2.1 Authentication via Cloudflare Tunnel

## Overview

This guide deploys your ConnectWise MCP server with OAuth 2.1 authentication, allowing
ChatGPT and other MCP clients to authenticate before accessing tools.

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

## Prerequisites

- Azure AD (Entra) App Registration (confidential client)
- Cloudflare Tunnel
- Docker

## Step 1: Azure AD App Registration

Create an App Registration for the gateway.

Required values:
- Tenant ID
- Client ID
- Client Secret

Redirect URIs (Web):
- `https://connectwisemcp.funcshun.com/oauth/callback`
- `https://chatgpt.com/connector_platform_oauth_redirect`
- `https://platform.openai.com/apps-manage/oauth`

Scopes:
- `openid profile email`

## Step 2: Configure Environment

Copy and edit the env file:
```
cp deploy/http-gateway/.env.example deploy/http-gateway/.env
```

Set values:
- `SERVER_URL=https://connectwisemcp.funcshun.com`
- `MCP_RESOURCE_URL=https://connectwisemcp.funcshun.com`
- `JWT_SECRET_KEY=...`
- `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`
- ConnectWise credentials
- `CLOUDFLARE_TUNNEL_TOKEN`

## Step 3: Build and Run

```
cd deploy/http-gateway
docker compose up -d --build
```

## Step 4: Verify discovery endpoints

```
curl https://connectwisemcp.funcshun.com/.well-known/oauth-protected-resource
curl https://connectwisemcp.funcshun.com/.well-known/oauth-authorization-server
```

## Step 5: Configure ChatGPT

- MCP URL: `https://connectwisemcp.funcshun.com/sse`
- Auth: OAuth
- Client ID/Secret: leave blank (dynamic registration)

Complete the Azure login when prompted.
