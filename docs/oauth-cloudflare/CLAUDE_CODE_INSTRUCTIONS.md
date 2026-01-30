# Claude Code Instructions: MCP Server with OAuth via Cloudflare

## Overview

This document provides step-by-step instructions for Claude Code to deploy an MCP server with OAuth 2.1 authentication, exposed via Cloudflare Tunnel for ChatGPT integration.

---

## Phase 1: Prerequisites Setup

### 1.1 Create Auth0 Account and Application

```bash
# Manual steps - do these in browser:
# 1. Go to https://auth0.com and create free account
# 2. Create new Application (Regular Web Application)
# 3. Note down: Domain, Client ID, Client Secret
# 4. Create API with identifier: https://mcp.yourdomain.com
```

### 1.2 Configure Auth0 Application

In Auth0 Dashboard, set these values for your application:

**Allowed Callback URLs:**
```
https://mcp.yourdomain.com/oauth/callback
http://localhost:8000/oauth/callback
```

**Allowed Logout URLs:**
```
https://mcp.yourdomain.com
http://localhost:8000
```

**Allowed Web Origins:**
```
https://mcp.yourdomain.com
http://localhost:8000
```

### 1.3 Create Cloudflare Tunnel

```bash
# Install cloudflared
brew install cloudflared  # macOS
# OR
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o cloudflared && chmod +x cloudflared

# Login to Cloudflare
cloudflared tunnel login

# Create tunnel
cloudflared tunnel create mcp-server

# Get tunnel token from dashboard or:
cloudflared tunnel token mcp-server
```

---

## Phase 2: Project Setup

### 2.1 Clone/Create Project Structure

```bash
# Create project directory
mkdir -p mcp-oauth-cloudflare
cd mcp-oauth-cloudflare

# The files are already created in /home/claude/mcp-oauth-cloudflare/
# Copy them to your working directory or use directly
```

### 2.2 Configure Environment

```bash
# Copy example env file
cp .env.example .env

# Edit .env with your values:
# - AUTH0_DOMAIN
# - AUTH0_CLIENT_ID
# - AUTH0_CLIENT_SECRET
# - AUTH0_AUDIENCE (your MCP URL)
# - JWT_SECRET_KEY (generate with: openssl rand -hex 32)
# - ConnectWise credentials
# - CLOUDFLARE_TUNNEL_TOKEN
```

### 2.3 Generate JWT Secret

```bash
openssl rand -hex 32
# Copy output to JWT_SECRET_KEY in .env
```

---

## Phase 3: Build and Deploy

### 3.1 Build Docker Image

```bash
cd mcp-oauth-cloudflare

# Build the image
docker compose build
```

### 3.2 Start Services

```bash
# Start in foreground (for debugging)
docker compose up

# OR start in background
docker compose up -d

# Check status
docker compose ps

# View logs
docker compose logs -f mcp-server
docker compose logs -f cloudflared
```

### 3.3 Verify Deployment

```bash
# Test health endpoint
curl http://localhost:8000/health

# Test OAuth discovery
curl http://localhost:8000/.well-known/oauth-protected-resource
curl http://localhost:8000/.well-known/oauth-authorization-server

# Test via Cloudflare (after DNS propagates)
curl https://mcp.yourdomain.com/health
```

---

## Phase 4: DNS Configuration

### 4.1 Route DNS to Tunnel

```bash
# Add DNS route
cloudflared tunnel route dns mcp-server mcp.yourdomain.com

# Verify DNS
dig mcp.yourdomain.com
```

### 4.2 Alternative: Manual DNS in Cloudflare Dashboard

1. Go to Cloudflare Dashboard → Your Domain → DNS
2. Add CNAME record:
   - Name: `mcp`
   - Target: `<tunnel-id>.cfargotunnel.com`
   - Proxy: Yes (orange cloud)

---

## Phase 5: Connect to ChatGPT

### 5.1 Enable Developer Mode in ChatGPT

1. Go to ChatGPT Settings
2. Navigate to Connectors → Advanced
3. Enable "Developer Mode"

### 5.2 Add MCP Connector

1. Go to ChatGPT → Settings → Connectors
2. Click "Add Connector" (+ icon)
3. Configure:
   - **Name:** ConnectWise MCP
   - **MCP Server URL:** `https://mcp.yourdomain.com/sse`
   - **Authentication:** OAuth
   - Leave Client ID/Secret empty (uses dynamic registration)
4. Click "Create"
5. Complete Auth0 login when prompted
6. Approve access

### 5.3 Test Connection

In ChatGPT, try:
```
Use ConnectWise to show me the latest 5 tickets
```

---

## Phase 6: Troubleshooting Commands

### Container Issues

```bash
# Restart containers
docker compose restart

# Rebuild and restart
docker compose down
docker compose build --no-cache
docker compose up -d

# Shell into container
docker compose exec mcp-server /bin/bash

# Check container logs
docker compose logs --tail=100 mcp-server
```

### OAuth Issues

```bash
# Test OAuth flow manually
curl -v http://localhost:8000/.well-known/oauth-protected-resource

# Check Auth0 logs
# Go to Auth0 Dashboard → Logs → Search for errors
```

### Network Issues

```bash
# Test local connectivity
curl -v http://localhost:8000/health

# Test tunnel connectivity
curl -v https://mcp.yourdomain.com/health

# Check DNS resolution
dig mcp.yourdomain.com
nslookup mcp.yourdomain.com
```

### MCP Tool Issues

```bash
# Test with valid token
TOKEN="your-access-token"
curl -H "Authorization: Bearer $TOKEN" http://localhost:8000/mcp

# Check tool registration in logs
docker compose logs mcp-server | grep -i tool
```

---

## Phase 7: Production Hardening

### 7.1 Security Updates

```bash
# Update .env for production
# Change these values:
SERVER_URL=https://mcp.yourdomain.com  # Use actual domain

# Regenerate secrets
openssl rand -hex 32  # New JWT_SECRET_KEY
```

### 7.2 Restrict CORS (in main.py)

```python
# Change from:
allow_origins=["*"]

# To:
allow_origins=[
    "https://chatgpt.com",
    "https://chat.openai.com",
    "https://claude.ai",
]
```

### 7.3 Add Rate Limiting

```bash
# Install additional package
# Add to requirements.txt: slowapi>=0.1.9

# Then add to main.py rate limiting middleware
```

### 7.4 Enable Logging

```bash
# Check logs directory
mkdir -p logs

# Add volume mount to docker-compose.yml:
volumes:
  - ./logs:/app/logs
```

---

## Quick Reference Commands

```bash
# Start everything
docker compose up -d

# Stop everything
docker compose down

# View logs
docker compose logs -f

# Rebuild
docker compose build --no-cache

# Test health
curl http://localhost:8000/health

# Test OAuth discovery
curl http://localhost:8000/.well-known/oauth-protected-resource

# Generate new JWT secret
openssl rand -hex 32
```

---

## File Locations

```
mcp-oauth-cloudflare/
├── DEPLOYMENT_GUIDE.md      # Full deployment documentation
├── CLAUDE_CODE_INSTRUCTIONS.md  # This file
├── docker-compose.yml       # Container orchestration
├── Dockerfile              # Python container build
├── requirements.txt        # Python dependencies
├── .env.example           # Environment template
├── .env                   # Your actual configuration (create this)
└── app/
    ├── __init__.py
    ├── main.py            # FastAPI + MCP server
    ├── auth.py            # OAuth 2.1 implementation
    └── config.py          # Configuration management
```
