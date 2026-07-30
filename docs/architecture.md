# ConnectWise MCP v2 Architecture

> **Status:** Proposed target architecture. The existing Docker deployment remains the supported implementation until the Worker passes tests, MCP conformance, and staging verification.

## Recommendation

Evolve this repository in place. Implement the new architecture on a feature branch, preserve the existing Docker deployment during migration, and merge only after the Cloudflare-native server reaches functional parity.

The target is a single stateless TypeScript Cloudflare Worker implementing the MCP 2026-07-28 protocol, Microsoft Entra authentication, deterministic per-user ConnectWise credential selection, and request-scoped ConnectWise clients.

## Target architecture

```mermaid
flowchart LR
    U[Claude / ChatGPT / MCP client]
    E[Microsoft Entra ID]
    W[Cloudflare Worker<br/>OAuth + stateless MCP + tools]
    M[Identity map<br/>tid:oid → profile alias]
    S[Worker secrets<br/>six credential profiles]
    C[ConnectWise Manage API]

    U -. OAuth 2.1 + PKCE .-> E
    E -. signed identity token .-> W
    U -->|MCP 2026-07-28 over HTTPS| W
    W -->|validate tid, oid, groups, roles| M
    M -->|profile alias only| S
    S -->|request-scoped credentials| W
    W -->|ConnectWise REST API| C
```

A richer standalone visual is available at [`architecture.html`](architecture.html). Persistent authentication and Entra configuration are covered in [`entra-authentication.md`](entra-authentication.md).

## Authorization model

Authentication and authorization have separate responsibilities:

1. **Entra identifies the caller.** The Worker validates the token signature, issuer, audience, tenant, expiry, and relevant claims.
2. **An Entra group gates application access.** For example, `ConnectWise-MCP-Users` determines who may connect.
3. **Immutable identity selects credentials.** The validated key `<tenant-id>:<object-id>` maps to one of six profile aliases such as `LUIS`.
4. **Cloudflare secrets hold credentials.** The browser and MCP client never receive ConnectWise keys.
5. **ConnectWise enforces business permissions.** The mapped API member's ConnectWise Security Role determines boards, companies, finance, projects, and read/write access.

Entra does not automatically translate its groups into ConnectWise Security Roles. The explicit identity-to-profile mapping is the bridge between the two systems.

## Six-user configuration

### Non-secret Worker variables

```text
AZURE_TENANT_ID
AZURE_CLIENT_ID
AZURE_AUDIENCE
ENTRA_ALLOWED_GROUP_IDS
```

The user-to-profile mapping may be a secret binding if Entra object IDs should not be visible in ordinary Worker configuration:

```json
{
  "<tenant-id>:<luis-object-id>": "LUIS",
  "<tenant-id>:<user-2-object-id>": "USER2",
  "<tenant-id>:<user-3-object-id>": "USER3",
  "<tenant-id>:<user-4-object-id>": "USER4",
  "<tenant-id>:<user-5-object-id>": "USER5",
  "<tenant-id>:<user-6-object-id>": "USER6"
}
```

Bind this JSON as `CW_USER_PROFILE_MAP`. Never commit real tenant IDs, object IDs, API keys, tokens, or client secrets to the repository.

### Per-profile Worker secrets

For each profile alias, provision:

```text
CW_PROFILE_<ALIAS>_COMPANY_ID
CW_PROFILE_<ALIAS>_PUBLIC_KEY
CW_PROFILE_<ALIAS>_PRIVATE_KEY
CW_PROFILE_<ALIAS>_CLIENT_ID
CW_PROFILE_<ALIAS>_API_URL
```

For Luis, the bindings are:

```text
CW_PROFILE_LUIS_COMPANY_ID
CW_PROFILE_LUIS_PUBLIC_KEY
CW_PROFILE_LUIS_PRIVATE_KEY
CW_PROFILE_LUIS_CLIENT_ID
CW_PROFILE_LUIS_API_URL
```

Enter secret values interactively so they do not appear in shell history:

```bash
npx wrangler secret put CW_PROFILE_LUIS_PUBLIC_KEY
npx wrangler secret put CW_PROFILE_LUIS_PRIVATE_KEY
```

## Request lifecycle

1. Client begins OAuth authorization with PKCE.
2. Entra authenticates the user.
3. Worker verifies the Entra token and preserves `tid`, `oid`, `groups`, and `roles` across its OAuth exchange.
4. Worker verifies membership in an allowed Entra group or app role.
5. Worker resolves `<tid>:<oid>` to a profile alias.
6. Worker loads only that profile's secret bindings.
7. Worker creates a new ConnectWise client for the request.
8. The MCP tool calls ConnectWise.
9. ConnectWise applies the selected API member's Security Role.
10. Worker logs caller identity, profile alias, tool, correlation ID, and outcome—never keys or bearer tokens.

## Fail-closed rules

Reject the request when:

- JWT signature, issuer, audience, tenant, or expiry validation fails.
- Required immutable claims are absent.
- The user is outside the Entra allowlist.
- No exact identity mapping exists.
- More than one credential profile is selected.
- Any required secret binding is missing.
- A client attempts to supply or override ConnectWise credentials.

There must be no fallback to a shared administrator profile.

## Repository migration strategy

```text
main
├── deploy/                         # Current Docker implementation, retained during migration
├── docs/
│   ├── architecture.md             # This specification
│   ├── architecture.html           # Standalone visual
│   └── migration-v2.md             # Implementation and rollback plan
└── worker/                          # Proposed Cloudflare-native implementation
    ├── src/
    ├── tests/
    ├── package.json
    └── wrangler.example.jsonc
```

Recommended delivery sequence:

1. **Documentation PR:** target design, threat model, secrets contract, migration plan.
2. **Worker foundation PR:** current SDKs, stateless handler, health endpoint, CI, no ConnectWise writes.
3. **Identity PR:** Entra validation and tested `tid:oid` profile resolution.
4. **Read-tools PR:** request-scoped ConnectWise client and read-only MCP tools.
5. **Write-tools PR:** explicit annotations, confirmation policy, least-privilege tests, and audit logging.
6. **Staging deployment:** six test profiles and MCP conformance suite.
7. **Cutover:** update clients, monitor, then mark Docker architecture as legacy.

## Security requirements

- Use exact issuer and audience allowlists; never decode a JWT without verifying it.
- Prefer Entra app roles assigned through groups when practical; raw group claims can be omitted for users with group overage.
- Use immutable `tid` plus `oid`, not display name or unverified email, for profile selection.
- Disable client-supplied `X-CW-*` credential headers in normal operation.
- Instantiate the ConnectWise client per request; never mutate global credentials.
- Add MCP tool annotations and enforce a separate policy for destructive operations.
- Bound query page sizes, request bodies, API timeouts, and retry behavior.
- Redact authorization headers, API keys, and ConnectWise error bodies from logs.
- Rotate API keys independently and disable mappings immediately when users leave.
- Keep Docker available as rollback until the Worker has operated successfully in production.

## Decision record

| Decision | Choice | Reason |
|---|---|---|
| Repository | Update existing repository | Same product; preserves history and discoverability |
| Runtime | Cloudflare Worker | Removes Docker, tunnel, and proxy layers |
| Language | TypeScript | Strong Cloudflare and MCP SDK support |
| MCP transport | Stateless HTTP | Aligns with MCP 2026-07-28 and simplifies scaling |
| Authentication | Microsoft Entra OAuth | Existing organizational identity provider |
| Access gate | Entra group or app role | Centralized joiner/mover/leaver control |
| Credential selection | Validated `tid:oid` map | Deterministic and resistant to renamed users |
| Credential storage | Worker secrets | Appropriate for six static profiles |
| ConnectWise scope | Per-profile API member Security Role | Least privilege and downstream enforcement |
| Admin UI | None | Unnecessary for six managed users |
