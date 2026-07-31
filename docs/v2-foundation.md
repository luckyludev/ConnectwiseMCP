# v2 secure Worker foundation

> **Status:** secure foundation plus the first request-scoped read-only ConnectWise slice; not production deployment instructions. The Docker/FastAPI implementation remains available for rollback until the Worker passes staging and ConnectWise integration gates.

## Included in foundation

- Cloudflare Worker TypeScript project with exact dependency versions and lockfile.
- Cloudflare `workers-oauth-provider` for OAuth 2.1 provider mechanics.
- Microsoft Entra authorization-code login with mandatory upstream S256 PKCE and OIDC nonce.
- Rotating Entra refresh tokens and eligibility rechecks during MCP refresh grants.
- Strict ID-token validation: `RS256`, issuer, audience, tenant, `exp`, `nbf`, `iat`, `tid`, and `oid`.
- Fail-closed group/app-role eligibility and exact `<tid>:<oid> → profile alias` mapping.
- Browser-bound signed state, local consent, and secure cookie attributes.
- CIMD support and allowlisted dynamic client redirect origins.
- Stateless MCP transport with `whoami` and a deliberately limited read-only `get_service_ticket` tool that returns only ticket ID and status metadata—never ticket-authored text.
- Per-request ConnectWise client creation from exactly one validated `CW_PROFILE_<ALIAS>` secret; no caller-supplied profile or credential headers and no shared fallback.
- Fixed ConnectWise endpoint construction, bounded timeout/retry/response size, strict metadata-only ticket projection, and sanitized errors.
- Structured best-effort audit events for both MCP tools with allowlisted identity, tool, outcome, correlation, and latency fields; tool inputs, credentials, tokens, URLs, headers, upstream bodies, and exception text are never included.
- Blocking tests, typecheck, formatting, npm audit, and Wrangler dry-run bundle in CI.

## Configuration

Set non-secret variables in `wrangler.jsonc` or environment-specific Wrangler configuration:

- `MCP_CANONICAL_URL`
- `ENTRA_TENANT_ID`
- `ENTRA_CLIENT_ID`
- `ALLOWED_GROUP_IDS` — JSON array
- `ALLOWED_APP_ROLES` — JSON array
- `ALLOWED_CLIENT_REDIRECT_URIS` — JSON array of exact HTTPS callback URIs; loopback HTTP callback paths must be explicitly allowed, while the port may vary for local clients

Provision these as Worker secrets; do not place values in Git, `.dev.vars`, command arguments, or ordinary request headers:

```bash
npx wrangler secret put ENTRA_CLIENT_SECRET
npx wrangler secret put OAUTH_STATE_SECRET
npx wrangler secret put IDENTITY_PROFILE_MAP
# Repeat once per configured alias, for example:
npx wrangler secret put CW_PROFILE_LUIS
```

`OAUTH_STATE_SECRET` must contain at least 32 random bytes. `IDENTITY_PROFILE_MAP` is JSON such as:

```json
{
  "<tenant-id>:<object-id>": "LUIS"
}
```

Each alias in `IDENTITY_PROFILE_MAP` must match `^[A-Z][A-Z0-9_]{0,31}$` and have exactly one corresponding `CW_PROFILE_<ALIAS>` Worker secret. Each profile secret is strict JSON with these fields:

```json
{
  "apiBaseUrl": "https://<connectwise-host>/v4_6_release/apis/3.0",
  "companyId": "<connectwise-company-id>",
  "publicKey": "<api-member-public-key>",
  "privateKey": "<api-member-private-key>",
  "clientId": "<connectwise-client-id>"
}
```

Set the non-secret `CONNECTWISE_ALLOWED_ORIGINS` Worker variable to a JSON array of the exact canonical ConnectWise origins used by these profiles, for example `["https://<connectwise-host>"]`. Origin entries must be canonical HTTPS origins with no path, credentials, query, or fragment. IP literals, localhost-class names, and `.local` names are rejected. Each profile's `apiBaseUrl` origin must match an entry literally. Keep this variable separate from profile secrets so compromise of one secret cannot redirect its Basic credentials to another host.

The runtime derives the binding name only from the authenticated grant's server-side profile alias and reads only that profile secret. MCP inputs and ordinary HTTP headers cannot select a profile or supply credentials. Requests use `redirect: "error"`; redirected responses are never followed. Missing, malformed, ambiguous, or incomplete configuration fails closed. Enter real credentials only through the Wrangler secret prompt or an approved Cloudflare secret-management workflow.

Create a production KV namespace and replace the placeholder binding ID. The maintained OAuth provider uses this binding for provider grants, authorization codes, client registrations, and refresh-token rotation. The upstream Entra browser state is signed, short-lived, and browser-bound rather than stored in KV.

## Microsoft Entra app registration

Register this exact web redirect URI:

```text
https://<worker-origin>/callback
```

Request `openid profile offline_access`. Configure group claims or app roles in the Entra application. For tenants where group overage is possible, prefer app roles until a Microsoft Graph overage-resolution path is deliberately implemented; this Worker rejects group-overage tokens when no allowed app role is present.

## Audit events and production observability

Every completed `whoami` or `get_service_ticket` invocation attempts to emit one single-line JSON event through the Worker logger. Audit delivery is best-effort: logger or serialization failures never alter the MCP response and are not recursively logged.

The event schema is allowlist-only:

| Field           | Meaning                                                                                       |
| --------------- | --------------------------------------------------------------------------------------------- |
| `version`       | Schema version `1`                                                                            |
| `event`         | Fixed value `mcp_tool_invocation`                                                             |
| `timestamp`     | UTC ISO-8601 event completion time                                                            |
| `correlationId` | Server-generated UUID                                                                         |
| `tenantId`      | Validated Entra tenant GUID when available                                                    |
| `objectId`      | Validated Entra object GUID when available                                                    |
| `profileAlias`  | Validated server-selected profile alias when available                                        |
| `tool`          | Fixed `whoami` or `get_service_ticket` value                                                  |
| `outcome`       | `success`, `denied`, or `failure`                                                             |
| `reason`        | Fixed sanitized reason: `ok`, `insufficient_scope`, `profile_unavailable`, or `lookup_failed` |
| `durationMs`    | Nonnegative integer latency, defensively capped at 300,000 ms                                 |

Malformed identity/profile fields are omitted. Malformed core correlation or clock fields suppress the event. The emitter never copies arbitrary properties from authentication context or exceptions.

Audit events deliberately exclude MCP arguments, ticket IDs, scopes, access or refresh tokens, authorization/cookie headers, Entra client secrets, OAuth state, ConnectWise credentials, profile JSON, API URLs, request or response bodies, upstream fields, and raw exception text. Do not add any of these fields to logging or downstream log-enrichment rules.

Before production cutover:

1. Restrict Cloudflare log access to approved operators and document the selected retention period; the Worker code assumes no retention duration.
2. Verify one event per successful staging call for both tools and verify `denied` events for scope/profile failures.
3. Run concurrent calls for at least two mapped users and confirm their tenant/object/profile fields remain isolated.
4. Inspect exported events and confirm no tool arguments, ticket content, tokens, headers, credentials, URLs, or upstream bodies appear.
5. Configure alerts for sustained `failure`/`denied` increases and for an unexpected absence of audit events during known test traffic. Alert payloads must use only the allowlisted schema.
6. Record the staging evidence and approved retention/access settings in [`v2-staging-acceptance-checklist.md`](v2-staging-acceptance-checklist.md). Local unit tests and Wrangler dry-run do not satisfy these live gates.

## Verification

```bash
npm ci
npm run check
```

`npm run check` executes strict typecheck, all tests, Prettier verification, npm audit at high severity, and a Wrangler `--dry-run` bundle. It does not deploy.

## Next stages

1. Treat [`legacy-read-surface-classification.md`](legacy-read-surface-classification.md) as the V2 migration decision record. Expand the read-only tool set only after a demonstrated requirement and a separate policy/schema review; do not add ticket text, notes, attachments, attachment metadata, generic endpoints, caller-defined conditions, or downloads by default.
2. Add guarded write tools with explicit OAuth/tool policy and destructive-operation controls.
3. Run Entra, MCP Inspector, staging ConnectWise, and six-user isolation tests.
4. Remove legacy Docker/FastAPI code only after rollback and cutover acceptance.
