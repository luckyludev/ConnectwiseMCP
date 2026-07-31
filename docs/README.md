# Documentation

## Architecture and migration

- [`architecture.md`](architecture.md) - proposed stateless Cloudflare Worker architecture, identity mapping, security requirements, and migration strategy
- [`architecture.html`](architecture.html) - standalone visual architecture diagram (download or serve with GitHub Pages to view)
- [`v2-foundation.md`](v2-foundation.md) - implemented Worker V2 security boundary and configuration reference
- [`legacy-read-surface-classification.md`](legacy-read-surface-classification.md) - explicit V2 migration decisions for the legacy MCP tool surface
- [`v2-staging-acceptance-checklist.md`](v2-staging-acceptance-checklist.md) - human-operated, non-secret staging and cutover gates

## Client and deployment guides

- [`entra-authentication.md`](entra-authentication.md) - persistent Entra sessions, refresh-token rotation, claims, Conditional Access, and troubleshooting
- `chatgpt-connector.md` - full setup for ChatGPT OAuth connector
- `claude-setup.md` - Claude MCP connector setup
- `n8n-setup.md` - call MCP from n8n via HTTP gateway
- `copilot-studio-azure.md` - Copilot Studio + Azure internal-only setup
- `troubleshooting.md` - common issues and checks
- `azure-ad-checklist.md` - Azure AD setup checklist
