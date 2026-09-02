# v2 secure Worker foundation

> **Status:** secure foundation plus a bounded request-scoped ConnectWise read/write business catalog; not production deployment instructions. The Docker/FastAPI implementation remains available for rollback until the Worker passes staging and ConnectWise integration gates.

## Included in foundation

- Cloudflare Worker TypeScript project with exact dependency versions and lockfile.
- Cloudflare `workers-oauth-provider` for OAuth 2.1 provider mechanics.
- Microsoft Entra authorization-code login with mandatory upstream S256 PKCE and OIDC nonce.
- Rotating Entra refresh tokens and eligibility rechecks during MCP refresh grants.
- Strict ID-token validation: `RS256`, issuer, audience, tenant, `exp`, `nbf`, `iat`, `tid`, and `oid`.
- Fail-closed group/app-role eligibility and exact `<tid>:<oid> → profile alias` mapping.
- Browser-bound signed state, local consent, and secure cookie attributes.
- CIMD support and allowlisted dynamic client redirect origins.
- Stateless MCP transport with a purpose-built catalog of 38 registered tools, of which 37 are model-visible and `upload_connectwise_image` is app-only. Every tool requires `mcp:read`; the 11 write-capable tools additionally require `mcp:write` before profile-secret lookup or ConnectWise client creation.
- Per-request ConnectWise client creation from exactly one validated `CW_PROFILE_<ALIAS>` secret; no caller-supplied profile or credential headers and no shared fallback.
- Fixed ConnectWise endpoint construction, strict input/result bounds, allowlisted response projections, GET-only retries, no automatic write retry, and sanitized errors.
- Bounded document handling: downloads stop at 8 MB. The app-only `upload_connectwise_image` path accepts only PNG, JPEG, GIF, or WebP, stops at 1 MB, verifies MIME signatures and file extensions, never fetches caller-supplied URLs, and uses a fixed multipart `POST /system/documents` for Ticket or TimeEntry records. The dormant direct-attachment write tools have different limits and must not be enabled without separate hardening and acceptance.
- A self-contained MCP App supported by Claude provides paste, drag/drop, and file selection. It resizes large raster images locally before invoking the app-only upload tool; an optional ticket note is a separate write so partial success is reported accurately.
- Structured best-effort audit events for every MCP tool with allowlisted identity, tool, outcome, correlation, and latency fields; tool inputs, credentials, tokens, URLs, headers, upstream bodies, and exception text are never included.
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

The runtime derives the binding name only from the authenticated grant's server-side profile alias and reads only that profile secret. MCP inputs and ordinary HTTP headers cannot select a profile or supply credentials. Requests use `redirect: "manual"` and explicitly reject every 3xx response because the Workers runtime does not implement `redirect: "error"`. Missing, malformed, ambiguous, or incomplete configuration fails closed. Enter real credentials only through the Wrangler secret prompt or an approved Cloudflare secret-management workflow.

The current authorization flow issues only `mcp:read`; it never issues or retains `mcp:write`. Consequently all write-capable tools fail with `Insufficient scope` before resolving a profile secret or constructing a ConnectWise client. Enabling writes requires a separate reviewed authorization policy, Entra and staging acceptance, and explicit `mcp:write` issuance; a ConnectWise Security Role alone cannot enable them.

Create a production KV namespace and replace the placeholder binding ID. The maintained OAuth provider uses this binding for provider grants, authorization codes, client registrations, and refresh-token rotation. The upstream Entra browser state is signed, short-lived, and browser-bound rather than stored in KV.

## Microsoft Entra app registration

Register this exact web redirect URI:

```text
https://<worker-origin>/callback
```

Request `openid profile offline_access`. Configure group claims or app roles in the Entra application. For tenants where group overage is possible, prefer app roles until a Microsoft Graph overage-resolution path is deliberately implemented; this Worker rejects group-overage tokens when no allowed app role is present.

## Audit events and production observability

Every completed tool invocation attempts to emit one single-line JSON event through the Worker logger. Audit delivery is best-effort: logger or serialization failures never alter the MCP response and are not recursively logged.

The event schema is allowlist-only:

| Field           | Meaning                                                                                                                       |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `version`       | Schema version `1`                                                                                                            |
| `event`         | Fixed value `mcp_tool_invocation`                                                                                             |
| `timestamp`     | UTC ISO-8601 event completion time                                                                                            |
| `correlationId` | Server-generated UUID                                                                                                         |
| `tenantId`      | Validated Entra tenant GUID when available                                                                                    |
| `objectId`      | Validated Entra object GUID when available                                                                                    |
| `profileAlias`  | Validated server-selected profile alias when available                                                                        |
| `tool`          | Fixed name from the registered tool catalog                                                                                   |
| `outcome`       | `success`, `denied`, or `failure`                                                                                             |
| `reason`        | Fixed sanitized reason such as `ok`, `insufficient_scope`, `profile_unavailable`, `connectwise_denied`, or `operation_failed` |
| `durationMs`    | Nonnegative integer latency, defensively capped at 300,000 ms                                                                 |

Malformed identity/profile fields are omitted. Malformed core correlation or clock fields suppress the event. The emitter never copies arbitrary properties from authentication context or exceptions.

Audit events deliberately exclude MCP arguments, ticket IDs, scopes, access or refresh tokens, authorization/cookie headers, Entra client secrets, OAuth state, ConnectWise credentials, profile JSON, API URLs, request or response bodies, upstream fields, and raw exception text. Do not add any of these fields to logging or downstream log-enrichment rules.

Before production cutover:

1. Restrict Cloudflare log access to approved operators and document the selected retention period; the Worker code assumes no retention duration.
2. Verify one event per successful staging call for every exercised tool and verify `denied` events for MCP scope/profile and ConnectWise permission failures.
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

1. Treat [`legacy-read-surface-classification.md`](legacy-read-surface-classification.md) as the V2 migration decision record. Do not add generic endpoints, caller-defined conditions, raw request bodies, or unbounded document transfer.
2. Run Entra, MCP Inspector, staging ConnectWise read-only, write-scope denial, and six-user isolation tests. Do not run live write tests unless a separately reviewed `mcp:write` policy and change window are approved.
3. Remove legacy Docker/FastAPI code only after rollback and cutover acceptance.
