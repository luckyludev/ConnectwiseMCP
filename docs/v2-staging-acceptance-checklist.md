# Worker V2 staging and cutover acceptance checklist

> **Status:** required human-operated staging evidence before any production cutover. This checklist does not authorize deployment, DNS changes, secret entry, or ConnectWise access by itself. Perform those actions only with the approved Cloudflare, Microsoft Entra, and ConnectWise operators.

## Rules for evidence

- Record dates, operator identity, environment, pass/fail result, and a link or identifier for retained evidence.
- Never paste access tokens, refresh tokens, OAuth state, authorization codes, cookies, headers, client secrets, ConnectWise API keys, profile-secret JSON, ticket IDs, URLs containing IDs, raw request/response bodies, or log exports into this file, Git, PRs, or issue comments.
- Use approved secure records for secret values and any sensitive screenshots. This repository should retain only sanitized result references.
- A failed required gate blocks promotion. Do not work around a failed authorization or isolation check by broadening roles, ConnectWise permissions, or tool output.

## 1. Change and environment control

- [ ] Record the immutable release commit and confirm CI passed `npm run check` on that exact commit.
- [ ] Identify the staging Cloudflare account, Worker name, canonical HTTPS MCP URL, and separate production target. Do not reuse production KV or secrets in staging.
- [ ] Confirm the Worker is on a paid plan or an explicitly approved Workers plan with limits adequate for OAuth provider KV use, logging, and expected traffic.
- [ ] Create separate staging KV namespaces for `OAUTH_KV` and its preview binding. Confirm the deployed Worker references staging namespace IDs rather than the placeholders in `wrangler.jsonc`.
- [ ] Confirm staging DNS/TLS ownership and rollback owner. Do not change production DNS in this phase.
- [ ] Record the legacy Docker/FastAPI rollback endpoint, responsible operator, and the conditions that trigger rollback. It remains a restricted rollback path, not a V2 compatibility target.

## 2. Non-secret Worker configuration

- [ ] Set `MCP_CANONICAL_URL` to the literal staging MCP URL, including the `/mcp` path, and verify no redirect changes its raw URL.
- [ ] Set the staging Entra tenant ID and client ID.
- [ ] Set non-empty `ALLOWED_GROUP_IDS` and/or `ALLOWED_APP_ROLES` according to the approved eligibility policy. Confirm assignments are least privilege.
- [ ] Set `ALLOWED_CLIENT_REDIRECT_URIS` to the exact approved client callback URIs. Include loopback callbacks only when their path is explicitly approved.
- [ ] Set `CONNECTWISE_ALLOWED_ORIGINS` to exact canonical HTTPS origins only. Confirm every allowed origin is approved, has no path/query/fragment/credentials, and matches the origin of a mapped profile API base URL literally.
- [ ] Confirm no client, ordinary request header, MCP argument, or browser query parameter can select a ConnectWise profile, host, endpoint, or credential.

## 3. Secret and identity-mapping control

- [ ] Enter secrets only through an approved Cloudflare secret-management workflow. Do not put secrets in `wrangler.jsonc`, `.dev.vars`, shell history, CI logs, screenshots, or evidence records.
- [ ] Provision a unique high-entropy `OAUTH_STATE_SECRET` of at least 32 random bytes.
- [ ] Provision the Entra client secret and confirm it is valid for the staging application without recording its value.
- [ ] Create `IDENTITY_PROFILE_MAP` using immutable Entra `<tid>:<oid>` keys only. Verify exactly the approved six test identities map to approved aliases; do not use names or emails as keys.
- [ ] Provision exactly one `CW_PROFILE_<ALIAS>` secret for each mapped alias. Verify each profile uses a dedicated ConnectWise API member/security role and least-privilege read permissions.
- [ ] Have an independent operator inspect binding names/counts and mapping coverage without exposing secret values. Confirm no unmapped identity can resolve a profile.

## 4. Entra/OAuth protocol acceptance

Perform these tests using approved staging identities and test clients; retain only sanitized evidence.

- [ ] Start login from the literal canonical MCP resource URL. Confirm Entra authorization uses S256 PKCE and OIDC nonce.
- [ ] Complete login for each of the six mapped identities. Confirm only each identity's own server-selected profile alias is returned by `whoami`.
- [ ] Attempt login as an unmapped but otherwise authenticated tenant identity. Confirm fail-closed denial with no profile-secret lookup.
- [ ] Attempt login without the approved group/app role. Confirm fail-closed denial with no profile-secret lookup.
- [ ] Test an ID token/audience/issuer/tenant failure in an approved non-production test path. Confirm a sanitized denial, not a callback crash or fallback.
- [ ] Test an unapproved dynamic-client redirect URI and a resource value differing from the canonical URL. Confirm registration/authorization is rejected.
- [ ] Complete an MCP refresh grant, then re-run eligibility after removing a staging role/group assignment. Confirm refresh is denied after eligibility revocation and no new profile client is created.
- [ ] Confirm authorization state, authorization code, and refresh-token behavior are one-time/rotating as implemented by the provider. Do not record token values.

## 5. MCP and ConnectWise acceptance

- [ ] Use MCP Inspector or another approved MCP client against staging; verify protocol discovery and OAuth interaction succeed over the canonical HTTPS URL.
- [ ] With each mapped test identity, call `whoami` and verify it returns only the expected profile alias.
- [ ] With each mapped test identity, call `get_service_ticket` only against an approved test ticket. Verify the response contains only numeric `id` and bounded `status`; it must not contain summary/description text, notes, attachments, metadata, URLs, credentials, or arbitrary upstream fields.
- [ ] Attempt malformed, zero, negative, non-integer, and excessively large tool arguments. Confirm schema rejection or sanitized failure; do not add a generic endpoint, condition, or raw request tool to diagnose errors.
- [ ] Send hostile profile/credential headers and MCP arguments while calling `get_service_ticket`. Confirm they cannot select another profile or alter the upstream host/client.
- [ ] Run simultaneous calls from at least two mapped identities to distinct approved test tickets. Confirm each invocation uses only its own ConnectWise API member and cannot observe the other user's profile-specific data.
- [ ] Use a ConnectWise API member lacking the test ticket permission. Confirm ConnectWise remains the final data-authorization boundary and the Worker returns only its sanitized lookup failure.
- [ ] Confirm only `whoami` and `get_service_ticket` are exposed. Verify the exclusions in [`legacy-read-surface-classification.md`](legacy-read-surface-classification.md): no raw API, generic conditions, notes, attachments, downloads, memory/debug/filesystem, or write tools.

## 6. Audit and operations acceptance

- [ ] Restrict Cloudflare log access/export to approved operators. Record the approved retention period and review cadence in the secure operations record.
- [ ] Verify exactly one allowlisted audit event for each successful `whoami` and `get_service_ticket` staging invocation, plus sanitized `denied` events for scope/profile denial cases.
- [ ] Inspect exported staging audit events. Confirm they contain no tool arguments, ticket IDs, ticket text/status values, tokens, headers, cookies, OAuth state, secrets, profile JSON, ConnectWise URLs, raw upstream bodies, or exception text.
- [ ] Configure alerts for sustained increases in `failure` or `denied` outcomes and for unexpected absence of audit events during known staging traffic. Alert payloads must remain limited to the audit allowlist.
- [ ] Record an incident contact, escalation path, and a tested procedure to disable access by removing a mapping/role and rotating the affected ConnectWise credential.

## 7. Promotion decision

All items below must be explicitly approved before production DNS/client cutover:

- [ ] All required sections above passed with sanitized evidence references.
- [ ] Security owner approved Entra eligibility, mapping, secret-management, audit retention/access, and alert configuration.
- [ ] ConnectWise owner approved each dedicated API member's least-privilege role and confirmed per-user data isolation testing.
- [ ] Service owner approved client redirect URIs, canonical URL, DNS/TLS plan, rollback plan, support coverage, and monitoring window.
- [ ] A change window and rollback decision authority are recorded.
- [ ] Production deployment and DNS/client updates are separately approved and executed by authorized operators. This repository checklist is not a deployment command.

## Completion record

Use an approved secure system—not this repository—to record:

- environment and canonical URL;
- release commit and CI run;
- operators/approvers and timestamps;
- sanitized evidence references for each required gate;
- decision: `staging accepted`, `promotion approved`, `rolled back`, or `blocked`;
- any remediation work and its follow-up release commit.
