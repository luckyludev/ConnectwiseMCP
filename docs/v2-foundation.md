# v2 secure Worker foundation

> **Status:** foundation branch; not production deployment instructions. The Docker/FastAPI implementation remains available for rollback until the Worker passes staging and ConnectWise integration gates.

## Included in foundation

- Cloudflare Worker TypeScript project with exact dependency versions and lockfile.
- Cloudflare `workers-oauth-provider` for OAuth 2.1 provider mechanics.
- Microsoft Entra authorization-code login with mandatory upstream S256 PKCE and OIDC nonce.
- Rotating Entra refresh tokens and eligibility rechecks during MCP refresh grants.
- Strict ID-token validation: `RS256`, issuer, audience, tenant, `exp`, `nbf`, `iat`, `tid`, and `oid`.
- Fail-closed group/app-role eligibility and exact `<tid>:<oid> → profile alias` mapping.
- Browser-bound signed state, local consent, and secure cookie attributes.
- CIMD support and allowlisted dynamic client redirect origins.
- Stateless MCP transport with a temporary read-only `whoami` foundation tool.
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
```

`OAUTH_STATE_SECRET` must contain at least 32 random bytes. `IDENTITY_PROFILE_MAP` is JSON such as:

```json
{
  "<tenant-id>:<object-id>": "LUIS"
}
```

Create a production KV namespace and replace the placeholder binding ID. The maintained OAuth provider uses this binding for provider grants, authorization codes, client registrations, and refresh-token rotation. The upstream Entra browser state is signed, short-lived, and browser-bound rather than stored in KV.

## Microsoft Entra app registration

Register this exact web redirect URI:

```text
https://<worker-origin>/callback
```

Request `openid profile offline_access`. Configure group claims or app roles in the Entra application. For tenants where group overage is possible, prefer app roles until a Microsoft Graph overage-resolution path is deliberately implemented; this Worker rejects group-overage tokens when no allowed app role is present.

## Verification

```bash
npm ci
npm run check
```

`npm run check` executes strict typecheck, all tests, Prettier verification, npm audit at high severity, and a Wrangler `--dry-run` bundle. It does not deploy.

## Next stages

1. Add the request-scoped ConnectWise client and read-only tools with tenant/profile-isolation tests.
2. Add guarded write tools with explicit OAuth/tool policy and destructive-operation controls.
3. Run Entra, MCP Inspector, staging ConnectWise, and six-user isolation tests.
4. Remove legacy Docker/FastAPI code only after rollback and cutover acceptance.
