# Microsoft Entra Authentication and Persistent MCP Sessions

## Why the current server asks for authentication every hour

The existing gateway creates its own access token with a fixed 3,600-second lifetime:

```python
expires_in=3600
```

Its OAuth metadata advertises support for `refresh_token`, but `/oauth/token` currently accepts only:

```text
grant_type=authorization_code
```

The token response contains an access token but no refresh token. When the one-hour access token expires, the MCP client has no renewal mechanism and must start interactive Entra authentication again.

This is primarily an OAuth implementation gap in the MCP gateway. A one-hour access-token lifetime is normal and should not simply be changed to weeks or months.

## Correct target behavior

```text
Initial connection
MCP client → authorization code + PKCE → gateway → Entra login
           ← access token + rotating refresh token ←

After approximately one hour
MCP client → grant_type=refresh_token → gateway
           ← new access token + replacement refresh token ←
```

The user should normally authenticate interactively only when:

- The refresh session expires.
- Entra revokes the session or requires sign-in.
- Conditional Access requires new interaction or MFA.
- The user changes credentials or an administrator revokes sessions.
- The user is removed from the allowed group/application.
- The OAuth client loses or discards its refresh token.

## Entra application configuration

### Redirect URI

Configure the Worker callback as a **Web** redirect URI in the Entra app registration:

```text
https://<mcp-domain>/oauth/callback
```

The value must match exactly, including scheme, hostname, path, and trailing slash behavior.

### Scopes

Request at least:

```text
openid profile email offline_access
```

`offline_access` is required for Microsoft Entra to return a refresh token. Add only the Microsoft Graph scopes actually needed; the MCP server does not need broad Graph permissions merely to authenticate users.

Example Worker setting:

```text
AZURE_SCOPES=openid profile email offline_access
```

### Token claims

The application must validate and preserve:

- `iss` — exact expected Entra issuer
- `aud` — exact application/API audience
- `exp` and `nbf` — token validity period
- `tid` — Entra tenant ID
- `oid` — immutable object ID
- `groups` or `roles` — access gate when present

Use `<tid>:<oid>` for the ConnectWise profile mapping. Do not authorize using display name or unverified email.

### Groups versus app roles

For a small deployment, one group such as `ConnectWise-MCP-Users` can gate access. Entra app roles assigned through groups are preferable when distinct MCP permissions are needed.

Be aware of group-claim overage: users with many group memberships may receive an overage indicator instead of the complete `groups` claim. App roles avoid this issue for application authorization. If raw groups are required, implement the documented Microsoft Graph overage resolution flow rather than treating a missing claim as authorization.

## Gateway refresh-token requirements

The gateway's `/oauth/token` endpoint must support both:

```text
grant_type=authorization_code
grant_type=refresh_token
```

On the initial code exchange, return:

```json
{
  "access_token": "[REDACTED]",
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_token": "[REDACTED]",
  "scope": "mcp:tools:read mcp:tools:execute"
}
```

On refresh:

1. Authenticate the OAuth client according to its registered method.
2. Validate the opaque refresh token using a timing-safe comparison against its stored hash.
3. Confirm it is unexpired, unused, not revoked, and bound to the same client and resource.
4. Revalidate the current Entra session/claims when using an Entra-backed refresh token.
5. Confirm the user remains in the allowed group or app role.
6. Preserve validated `tid`, `oid`, groups, and roles in the renewed local access token.
7. Rotate the refresh token and invalidate the consumed token atomically.
8. Return a new access token and replacement refresh token.

Clients must replace the old refresh token when a new one is returned.

## Storage on Cloudflare

MCP requests remain stateless even if OAuth uses small amounts of security state. These are different concerns.

A practical design uses Workers KV for:

- Short-lived OAuth authorization state and PKCE records
- Hashed local refresh-token identifiers
- Client/resource binding
- Expiration and revocation metadata
- Rotation-family identifiers and reuse detection

Never store plaintext ConnectWise credentials or plaintext refresh tokens in ordinary KV. Store ConnectWise credentials as Worker secrets. If an Entra refresh token must be retained server-side, encrypt it with an authenticated-encryption key held as a Worker secret and bind the ciphertext to the user/client metadata.

Suggested refresh record fields:

```json
{
  "tokenHash": "sha256:[REDACTED]",
  "familyId": "opaque-random-id",
  "tenantId": "<tenant-id>",
  "objectId": "<object-id>",
  "clientId": "<oauth-client-id>",
  "resource": "https://<mcp-domain>/mcp",
  "scope": "mcp:tools:read mcp:tools:execute",
  "expiresAt": 0,
  "consumedAt": null,
  "revokedAt": null
}
```

## Recommended lifetimes

- MCP/local access token: approximately **one hour**
- Authorization code: **5–10 minutes**, single use
- OAuth state/PKCE record: **5–10 minutes**, single use
- Local rotating refresh session: choose an organizational policy, such as **7–30 days**, subject to Entra and Conditional Access

Do not treat a long refresh lifetime as guaranteed. Refresh can fail because of revocation, password/security events, Conditional Access, tenant policy, consent changes, or client-side token loss. The client must gracefully restart authorization when interaction is required.

## Conditional Access and sign-in frequency

If refresh-token support is correctly implemented but users are still prompted frequently, inspect Entra:

1. **Enterprise applications → Sign-in logs** for the affected user and application.
2. The sign-in event's **Conditional Access** tab.
3. Policies containing **Sign-in frequency**, session controls, device compliance, location, or MFA requirements.
4. Whether the application is configured as a Web app or SPA; SPA refresh behavior differs and is not appropriate for a confidential Worker callback.
5. Consent and requested scopes, especially `offline_access`.

Conditional Access may intentionally require interaction. The application must not bypass those controls by issuing an excessively long self-contained access token.

## Current repository gap

The current Python gateway:

- Issues a local token with `expires_in=3600`.
- Advertises `refresh_token` in OAuth metadata.
- Rejects any grant other than `authorization_code`.
- Does not return a refresh token.
- Does not preserve all immutable Entra identity and authorization claims in its local token.

Until that implementation is fixed, hourly reauthentication is expected.

## Verification checklist

- [ ] Authorization request includes `offline_access`.
- [ ] Entra token response includes a refresh token.
- [ ] MCP gateway's initial token response includes its refresh token.
- [ ] MCP client sends `grant_type=refresh_token` before/after access-token expiry.
- [ ] Refresh returns a new access token and replacement refresh token.
- [ ] Old refresh-token reuse is detected and rejected.
- [ ] Renewed tokens retain validated `tid`, `oid`, groups, and roles.
- [ ] Removing a user from the allowed group prevents subsequent refresh.
- [ ] Revocation and Conditional Access failures trigger a clean interactive reauthorization.
- [ ] Logs contain correlation IDs and outcomes, never tokens or secrets.

## References

- [Microsoft identity platform OAuth 2.0 authorization code flow](https://learn.microsoft.com/entra/identity-platform/v2-oauth2-auth-code-flow)
- [Refresh tokens in the Microsoft identity platform](https://learn.microsoft.com/entra/identity-platform/refresh-tokens)
