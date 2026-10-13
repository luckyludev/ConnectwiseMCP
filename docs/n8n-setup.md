# n8n Setup

## Cloudflare Worker V2

Direct n8n onboarding is not currently approved. Worker V2 requires interactive Microsoft Entra authorization, immutable `tid` + `oid` profile mapping, and the `mcp:read` scope before profile-secret access. Do not emulate this boundary with a static credential, shared API member, caller-selected profile, or generic ConnectWise endpoint.

The supported read boundary is documented in the [migration classification](legacy-read-surface-classification.md). Any future n8n integration must pass the [V2 staging acceptance checklist](v2-staging-acceptance-checklist.md) and use an explicitly approved identity and OAuth flow.

## Legacy rollback gateway

The Docker/FastAPI JSON-RPC gateway and its static bearer flow are retained only for controlled emergency rollback. They are not a standing n8n integration path. Do not expose the gateway publicly, attach a tunnel, or configure an n8n credential against it from this guide.

During an approved rollback, an authorized operator must use the verified canonical `main` artifact and the [cutover and rollback runbook](cutover-rollback-runbook.md). The operator will provide the time-bounded endpoint, credential handling requirements, and perimeter controls if n8n access is part of the approved incident plan.

Never store ConnectWise, Entra, Cloudflare, signing, or rollback bearer credentials in workflow exports, source control, logs, or issue reports.
