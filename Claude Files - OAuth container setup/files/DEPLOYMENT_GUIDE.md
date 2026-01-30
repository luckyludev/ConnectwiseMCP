# MCP Server with OAuth 2.1 Authentication via Cloudflare Tunnel

## Overview

This guide deploys your ConnectWise MCP server with full OAuth 2.1 authentication, allowing ChatGPT and other MCP clients to securely authenticate before accessing your tools.

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────────┐
│  ChatGPT/Claude │────▶│ Cloudflare Tunnel │────▶│  Docker Container   │
│   MCP Client    │     │   (mcp.domain)    │     │  ┌───────────────┐  │
└─────────────────┘     └──────────────────┘     │  │  MCP Server   │  │
        │                                         │  │  (FastMCP)    │  │
        │                                         │  └───────────────┘  │
        │                                         │  ┌───────────────┐  │
        └────────────────────────────────────────▶│  │ OAuth Server  │  │
              OAuth Flow (Auth0/Google)           │  │ (Auth0 OIDC)  │  │
                                                  │  └───────────────┘  │
                                                  └─────────────────────┘
```

## Prerequisites

1. **Auth0 Account** (free tier works) - https://auth0.com
2. **Cloudflare Account** with a domain configured
3. **Docker** installed on your server
4. **Your existing ConnectWise MCP server code**

---

## Step 1: Auth0 Configuration

### 1.1 Create Auth0 Application

1. Go to Auth0 Dashboard → Applications → Create Application
2. Choose "Regular Web Application"
3. Name it "MCP Server - ConnectWise"
4. Note your:
   - **Domain**: `your-tenant.auth0.com`
   - **Client ID**: `xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`
   - **Client Secret**: `xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`

### 1.2 Configure Application Settings

In your Auth0 Application settings:

```
Allowed Callback URLs:
https://mcp.yourdomain.com/auth/callback
http://localhost:8000/auth/callback

Allowed Logout URLs:
https://mcp.yourdomain.com
http://localhost:8000

Allowed Web Origins:
https://mcp.yourdomain.com
http://localhost:8000
```

### 1.3 Enable Dynamic Client Registration (Required for MCP)

1. Go to Auth0 Dashboard → Settings → Advanced
2. Enable "OIDC Conformant"
3. Go to APIs → Create API:
   - Name: "MCP Server API"
   - Identifier: `https://mcp.yourdomain.com`
   - Signing Algorithm: RS256

### 1.4 Create Auth0 Action for Dynamic Client Registration

1. Go to Actions → Library → Build Custom
2. Name: "MCP Dynamic Client Registration"
3. Add this code:

```javascript
exports.onExecutePostLogin = async (event, api) => {
  // Add MCP-specific claims
  api.accessToken.setCustomClaim('mcp_scope', 'tools:read tools:execute');
};
```

---

## Step 2: Environment Configuration

### 2.1 Create .env file

```bash
# Auth0 Configuration
AUTH0_DOMAIN=your-tenant.auth0.com
AUTH0_CLIENT_ID=your-client-id
AUTH0_CLIENT_SECRET=your-client-secret
AUTH0_AUDIENCE=https://mcp.yourdomain.com

# Server Configuration
SERVER_URL=https://mcp.yourdomain.com
SERVER_HOST=0.0.0.0
SERVER_PORT=8000

# JWT Secret (generate with: openssl rand -hex 32)
JWT_SECRET_KEY=your-generated-secret-key

# ConnectWise API (your existing config)
CW_COMPANY_ID=your_company
CW_PUBLIC_KEY=your_public_key
CW_PRIVATE_KEY=your_private_key
CW_CLIENT_ID=your_client_id
CW_API_URL=https://api-na.myconnectwise.net/v4_6_release/apis/3.0

# Cloudflare Tunnel Token (get from dashboard)
CLOUDFLARE_TUNNEL_TOKEN=your-tunnel-token
```

---

## Step 3: File Structure

Create these files in your project directory:

```
mcp-oauth-cloudflare/
├── docker-compose.yml
├── Dockerfile
├── .env
├── requirements.txt
├── app/
│   ├── __init__.py
│   ├── main.py              # FastAPI + MCP server
│   ├── auth.py              # OAuth 2.1 implementation
│   ├── config.py            # Configuration
│   └── tools/
│       ├── __init__.py
│       └── connectwise.py   # Your CW tools
└── cloudflared/
    └── config.yml
```

---

## Step 4: Build Commands for Claude Code

Run these commands in sequence:

### 4.1 Initial Setup

```bash
# Create project directory
mkdir -p mcp-oauth-cloudflare/app/tools
cd mcp-oauth-cloudflare

# Create all configuration files (see files below)
```

### 4.2 Build and Start

```bash
# Build the Docker image
docker compose build

# Start the services
docker compose up -d

# Check logs
docker compose logs -f mcp-server

# Test the health endpoint
curl http://localhost:8000/health
```

### 4.3 Cloudflare Tunnel Setup

```bash
# Login to Cloudflare (one-time)
docker run -it --rm cloudflare/cloudflared tunnel login

# Create tunnel
docker run -it --rm cloudflare/cloudflared tunnel create mcp-server

# Route DNS
docker run -it --rm cloudflare/cloudflared tunnel route dns mcp-server mcp.yourdomain.com
```

---

## Step 5: Testing

### 5.1 Test OAuth Flow Locally

```bash
# Visit in browser
open http://localhost:8000/mcp_oauth_test.html

# Or test with curl
curl http://localhost:8000/.well-known/oauth-protected-resource
curl http://localhost:8000/.well-known/oauth-authorization-server
```

### 5.2 Test MCP Endpoints

```bash
# Should return 401 without token
curl http://localhost:8000/mcp

# After getting token from OAuth flow
curl -H "Authorization: Bearer YOUR_TOKEN" http://localhost:8000/mcp
```

### 5.3 Connect from ChatGPT

1. Go to ChatGPT → Settings → Connectors → Add Connector
2. Enter:
   - Name: `ConnectWise MCP`
   - URL: `https://mcp.yourdomain.com/sse`
   - Authentication: `OAuth`
   - (Leave Client ID/Secret empty - uses dynamic registration)
3. Click Create
4. Complete the Auth0 login flow when prompted

---

## Step 6: Production Deployment

### 6.1 Security Checklist

- [ ] Change all secrets in `.env`
- [ ] Enable HTTPS only (Cloudflare handles this)
- [ ] Set up Auth0 rate limiting
- [ ] Configure proper CORS origins
- [ ] Enable Auth0 brute force protection
- [ ] Set up logging and monitoring

### 6.2 Monitoring

```bash
# View container logs
docker compose logs -f

# Check container health
docker compose ps

# Restart if needed
docker compose restart mcp-server
```

---

## Troubleshooting

### OAuth Flow Fails

1. Check Auth0 callback URLs match exactly
2. Verify `AUTH0_DOMAIN` doesn't have `https://` prefix
3. Check Auth0 logs for error details

### MCP Tools Not Appearing

1. Verify token has correct scopes
2. Check MCP server logs for tool registration
3. Test tools endpoint: `curl -H "Auth..." https://mcp.yourdomain.com/mcp/tools`

### Cloudflare Tunnel Issues

1. Check tunnel status: `docker compose logs cloudflared`
2. Verify DNS is propagated: `dig mcp.yourdomain.com`
3. Test directly: `curl -v https://mcp.yourdomain.com/health`

---

## Files Reference

See the following files in this directory:
- `docker-compose.yml` - Container orchestration
- `Dockerfile` - Python container build
- `requirements.txt` - Python dependencies
- `app/main.py` - Main server code
- `app/auth.py` - OAuth implementation
- `app/config.py` - Configuration management
- `cloudflared/config.yml` - Tunnel configuration
