# Copilot Studio + Azure

## Cloudflare Worker V2

Copilot Studio onboarding is not currently approved. Worker V2 requires interactive Microsoft Entra authorization, immutable `tid` + `oid` profile mapping, and `mcp:read` authorization before profile-secret access. Do not replace those controls with a shared service credential, caller-selected profile, generic endpoint, or independently hosted copy of the legacy gateway.

Any future Copilot Studio integration must pass the [V2 staging acceptance checklist](v2-staging-acceptance-checklist.md) and preserve the supported [read-surface boundary](legacy-read-surface-classification.md).

## Legacy rollback gateway

The Docker/FastAPI gateway is retained only as a controlled, time-bounded emergency rollback path. This repository does not approve an independent Azure App Service deployment, container rebuild, registry push, public endpoint, or permanent Power Platform connector for that gateway.

If Worker V2 must be rolled back, an authorized operator must use the verified canonical `main` artifact and follow the [cutover and rollback runbook](cutover-rollback-runbook.md). That procedure governs artifact verification, network restrictions, secret handling, monitoring, and reversal after the incident. Client configuration may proceed only against the endpoint and controls produced by that approved procedure.

Never copy Entra, ConnectWise, Cloudflare, signing, static bearer, or dynamic-registration secrets into connector definitions, source control, logs, or issue reports.
