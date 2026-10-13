# Documentation

## Architecture and migration

- [`architecture.md`](architecture.md) - proposed stateless Cloudflare Worker architecture, identity mapping, security requirements, and migration strategy
- [`architecture.html`](architecture.html) - standalone visual architecture diagram (download or serve with GitHub Pages to view)
- [`v2-foundation.md`](v2-foundation.md) - implemented Worker V2 security boundary and configuration reference
- [`legacy-read-surface-classification.md`](legacy-read-surface-classification.md) - explicit V2 migration decisions for the legacy MCP tool surface
- [`v2-staging-acceptance-checklist.md`](v2-staging-acceptance-checklist.md) - human-operated, non-secret staging and cutover gates
- [`cloudflare-workers-staging-howto.md`](cloudflare-workers-staging-howto.md) - safe Cloudflare Workers staging operator procedure and approval boundaries
- [`claude-setup.md`](claude-setup.md) - Worker V2 Claude connector boundary, disabled-write status, localhost development, and retained legacy rollback reference

## Client support and rollback references

> Worker V2 onboarding is human-gated by [`v2-staging-acceptance-checklist.md`](v2-staging-acceptance-checklist.md). The status pages below do not authorize independent legacy deployment; any emergency rollback follows [`cutover-rollback-runbook.md`](cutover-rollback-runbook.md).

- [`entra-authentication.md`](entra-authentication.md) - legacy Entra session and troubleshooting reference
- [`chatgpt-connector.md`](chatgpt-connector.md) - Worker V2 ChatGPT boundary and controlled rollback reference
- [`n8n-setup.md`](n8n-setup.md) - n8n support status and controlled rollback reference
- [`copilot-studio-azure.md`](copilot-studio-azure.md) - Copilot Studio support status and controlled rollback reference
- [`troubleshooting.md`](troubleshooting.md) - legacy gateway troubleshooting
- [`azure-ad-checklist.md`](azure-ad-checklist.md) - legacy Azure AD setup checklist
