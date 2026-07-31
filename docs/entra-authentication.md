# Microsoft Entra authentication and persistent MCP sessions — legacy rollback analysis

> **Legacy-only:** this is a historical analysis of the Docker/FastAPI rollback gateway’s former refresh-token gap. It is not Worker V2 configuration guidance. For the implemented Worker V2 boundary, use [v2-foundation.md](v2-foundation.md); execute live staging only through the human-operated [V2 staging acceptance checklist](v2-staging-acceptance-checklist.md).

## Historical legacy behavior

The legacy Docker/FastAPI gateway issues a local access token with a fixed 3,600-second lifetime. Its OAuth metadata advertises `refresh_token`, but its token endpoint accepts only the authorization-code grant and does not return a refresh token. Consequently, legacy clients must begin interactive Entra authentication again when their access token expires.

A one-hour access-token lifetime is not itself the defect. The missing refresh-token grant and rotation are the legacy implementation gap. The Docker/FastAPI gateway remains a restricted rollback path and must not be expanded or used as the Worker V2 deployment target.

## Worker V2 status and boundary

Worker V2 implements the intended OAuth model: Entra authorization-code login with S256 PKCE and nonce, strict ID-token validation, rotating Entra refresh-token handling, and eligibility rechecks during MCP refresh grants. It maps only validated immutable Entra `<tid>:<oid>` identity pairs to server-selected ConnectWise profile aliases.

Do not copy legacy callback paths, environment-variable names, scopes, KV record designs, local-token examples, or storage advice from historical gateway documentation into a Worker configuration. The authoritative V2 configuration contract—including the exact Entra callback URI—is [`v2-foundation.md`](v2-foundation.md). The staging checklist governs live validation, secret handling, six-user isolation, audit review, rollback, and promotion approval.

## Required V2 acceptance evidence

Before V2 promotion, authorized operators must record sanitized evidence that:

- Entra authorization starts from the literal canonical MCP resource and uses S256 PKCE plus nonce.
- Only mapped, eligible identities receive a server-selected profile; unmapped or ineligible identities fail closed.
- Refresh-token rotation and post-revocation eligibility denial work as intended.
- OAuth callback/resource/redirect failures are sanitized and do not fall back to a profile or client secret.
- No token, state, code, secret, profile JSON, header, or raw request/response body appears in source control or acceptance evidence.

See the [V2 staging acceptance checklist](v2-staging-acceptance-checklist.md) for the full required record.

## References

- [Microsoft identity platform OAuth 2.0 authorization code flow](https://learn.microsoft.com/entra/identity-platform/v2-oauth2-auth-code-flow)
- [Refresh tokens in the Microsoft identity platform](https://learn.microsoft.com/entra/identity-platform/refresh-tokens)
