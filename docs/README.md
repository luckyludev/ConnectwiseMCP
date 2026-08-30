# Documentation

## Architecture and migration

- [`architecture.md`](architecture.md) - proposed stateless Cloudflare Worker architecture, identity mapping, security requirements, and migration strategy
- [`architecture.html`](architecture.html) - standalone visual architecture diagram (download or serve with GitHub Pages to view)
- [`v2-foundation.md`](v2-foundation.md) - implemented Worker V2 security boundary and configuration reference
- [`legacy-read-surface-classification.md`](legacy-read-surface-classification.md) - explicit V2 migration decisions for the legacy MCP tool surface
- [`v2-staging-acceptance-checklist.md`](v2-staging-acceptance-checklist.md) - human-operated, non-secret staging and cutover gates
- [`cloudflare-workers-staging-howto.md`](cloudflare-workers-staging-howto.md) - safe Cloudflare Workers staging operator procedure and approval boundaries
- [`claude-setup.md`](claude-setup.md) - Worker V2 Claude connector usage, inline image uploads, and retained legacy rollback reference

## Legacy rollback client/deployment guides

> These guides are retained only for the restricted Docker/FastAPI rollback path. They are not Worker V2 deployment or onboarding instructions; follow [`v2-staging-acceptance-checklist.md`](v2-staging-acceptance-checklist.md) for the human-gated V2 path.

- [`entra-authentication.md`](entra-authentication.md) - legacy Entra session and troubleshooting reference
- `chatgpt-connector.md` - legacy ChatGPT OAuth connector setup
- `n8n-setup.md` - legacy HTTP gateway setup
- `copilot-studio-azure.md` - legacy Azure App Service/Copilot pattern
- `troubleshooting.md` - legacy gateway troubleshooting
- `azure-ad-checklist.md` - legacy Azure AD setup checklist
