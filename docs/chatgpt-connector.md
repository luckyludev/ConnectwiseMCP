# ChatGPT Connector Setup (OAuth)

## Cloudflare Worker V2

Worker V2 is the production target. Client onboarding remains human-gated until the non-secret [V2 staging acceptance checklist](v2-staging-acceptance-checklist.md) passes. The approved operator supplies the canonical Worker `/mcp` URL; users then complete Microsoft Entra sign-in. Do not enter ConnectWise or Cloudflare credentials in ChatGPT.

The current OAuth flow issues `mcp:read` only. Write-capable tools remain registered for compatibility but require the unissued `mcp:write` scope and are denied before any profile secret is resolved. The supported read boundary is documented in the [migration classification](legacy-read-surface-classification.md).

## Legacy rollback gateway

The Docker/FastAPI gateway supports older OAuth clients, but it is retained only as a controlled emergency rollback path. It is not an alternate production deployment or a client-managed setup path.

Do not build or publish a replacement image, start its tunnel, add public routes, or configure Entra redirects from this guide. If Worker V2 must be rolled back, an authorized operator must use the verified canonical `main` artifact and follow the [cutover and rollback runbook](cutover-rollback-runbook.md). That procedure establishes the time-bounded endpoint, perimeter controls, monitoring, and approved client configuration.

Never place Entra, ConnectWise, Cloudflare, local signing, static bearer, or dynamic-registration secrets in connector fields, source control, logs, or issue reports.
