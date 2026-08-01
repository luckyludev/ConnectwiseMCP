# Cloudflare Workers V2 staging operator how-to

> **Purpose:** safely prepare and validate a Cloudflare Workers staging environment for ConnectWise MCP V2. This is an operator procedure, not production cutover authorization. It never authorizes secret disclosure, live ConnectWise access, DNS changes, or production deployment.

## Boundaries and prerequisites

- Use an approved Cloudflare account and a staging-only Worker/KV target. Never reuse production KV namespaces or Worker secrets in staging.
- Use a dedicated staging Worker name and, initially, an account `workers.dev` hostname to avoid custom DNS changes. A custom domain needs its own explicit DNS/TLS approval.
- Run commands from a reviewed release checkout after `npm ci` and `npm run check` pass.
- Use the active Wrangler OAuth session or approved operator authentication. Do not paste tokens, browser cookies, config files, account IDs, or secrets into chat, Git, PRs, shell history, screenshots, or this document.
- The implementation must remain fail-closed until all non-secret policy settings and secrets are intentionally entered. Do not make placeholder values functional by weakening authorization checks.

## 1. Inspect—do not mutate

The operator can verify local authentication and existing KV namespaces before planning a change:

```bash
npx wrangler whoami
npx wrangler kv namespace list
npm ci
npm run check
npx wrangler deploy --env staging --dry-run --outdir dist-staging
rm -rf dist-staging
```

`npm run check` runs typechecking, tests, formatting, a high-severity npm audit, and an explicit top-level dry-run. The staging dry-run validates the selected environment but does not publish a Worker.

Record account/operator and release evidence in an approved secure operations record. Do not put sensitive command output in Git.

## 2. Inventory and isolate staging OAuth storage

Namespaces are account-scoped, not domain-scoped. Before creating anything, inventory the approved Cloudflare account and the reviewed `env.staging` configuration:

```bash
npx wrangler kv namespace list
npx wrangler deploy --env staging --dry-run --outdir dist-staging
rm -rf dist-staging
```

Confirm the `OAUTH_KV` namespace already bound in `wrangler.jsonc` is the approved **runtime** staging namespace. Do not create another runtime namespace or replace that binding merely because this procedure is being followed. Record only sanitized evidence in the secure operations record; do not paste namespace IDs into chat, tickets, or this repository.

The acceptance checklist also requires a distinct **preview** KV namespace/binding. The current staging environment does not yet define a preview binding, so it does **not** satisfy that acceptance item. Create and bind a preview namespace only with separate operator approval, after first confirming that one does not already exist:

```bash
npx wrangler kv namespace create connectwise-mcp-v2-staging-oauth-preview
```

Add the resulting identifier only to a reviewed staging binding, separate from the runtime ID:

```jsonc
{
  "env": {
    "staging": {
      "workers_dev": true,
      "kv_namespaces": [
        {
          "binding": "OAUTH_KV",
          "id": "<STAGING_RUNTIME_KV_ID>",
          "preview_id": "<STAGING_PREVIEW_KV_ID>",
        },
      ],
    },
  },
}
```

Worker environments do **not** inherit KV bindings or `vars`; define every required non-secret binding and variable in the `staging` block. Keep production placeholders and production bindings separate.

## 3. Establish the literal canonical staging resource

For a Workers.dev staging Worker named `connectwise-mcp-v2-staging`, the canonical resource is exactly:

```text
https://connectwise-mcp-v2-staging.<workers-dev-subdomain>.workers.dev/mcp
```

The value must be literal and canonical: HTTPS only; `/mcp` path included; no redirect, credentials, query, fragment, port, or trailing-slash variation. Set it as `env.staging.vars.MCP_CANONICAL_URL` before first publish. The Worker validates this URL during startup, so a non-URL placeholder prevents deployment.

Keep the rest of the staging non-secret configuration deliberately incomplete until the approved Entra and ConnectWise settings are available:

```jsonc
{
  "vars": {
    "MCP_CANONICAL_URL": "https://connectwise-mcp-v2-staging.<workers-dev-subdomain>.workers.dev/mcp",
    "ENTRA_TENANT_ID": "REPLACE_WITH_STAGING_TENANT_ID",
    "ENTRA_CLIENT_ID": "REPLACE_WITH_STAGING_CLIENT_ID",
    "ALLOWED_GROUP_IDS": "[]",
    "ALLOWED_APP_ROLES": "[]",
    "ALLOWED_CLIENT_REDIRECT_URIS": "[]",
    "CONNECTWISE_ALLOWED_ORIGINS": "[]",
  },
}
```

Empty eligibility lists and absent secrets must remain fail-closed. Do not deploy an Entra/ConnectWise-capable service until the separate approvals below are complete.

## 4. Review and publish the fail-closed staging Worker

A configuration change requires the normal repository review and CI process. Once the target release is merged and an authorized operator explicitly approves deployment, publish only the staging environment:

```bash
npx wrangler deploy --env staging
```

This creates or updates the staging Worker and its Workers.dev endpoint. It does not create a custom-domain route, but it is an external deployment and must be recorded in the secure operations record.

Immediately verify only the public, non-sensitive boundary:

```bash
curl --silent --show-error --max-time 20 \
  https://connectwise-mcp-v2-staging.<workers-dev-subdomain>.workers.dev/.well-known/oauth-protected-resource/mcp
```

Confirm the metadata resource exactly equals the configured `/mcp` URL. An unauthenticated MCP POST should receive an OAuth challenge rather than run a tool. Do not use real bearer tokens, ConnectWise credentials, or ticket IDs for this preliminary check.

## 5. Configure Entra and non-secret policy settings

This step needs Entra/operator approval. Configure the staging Entra application with the exact web redirect URI:

```text
https://connectwise-mcp-v2-staging.<workers-dev-subdomain>.workers.dev/callback
```

Then replace only the approved staging values in `wrangler.jsonc`:

- `ENTRA_TENANT_ID`
- `ENTRA_CLIENT_ID`
- non-empty `ALLOWED_GROUP_IDS` and/or `ALLOWED_APP_ROLES`
- `ALLOWED_CLIENT_REDIRECT_URIS` containing only exact approved HTTPS callbacks (or explicitly approved loopback paths)
- `CONNECTWISE_ALLOWED_ORIGINS`, a JSON array of exact canonical approved ConnectWise HTTPS origins

Do not add names, email addresses, ticket identifiers, raw URLs with paths, localhost/IP origins, or caller-selectable endpoints. Identity-to-profile selection remains an immutable Entra `<tid>:<oid>` mapping stored as a secret.

## 6. Enter secrets interactively after separate approval

Only an authorized operator should enter secrets using Wrangler’s secure prompt or an approved Cloudflare secret-management workflow. Never put a secret value on the command line or in a redirected shell pipeline.

```bash
npx wrangler secret put ENTRA_CLIENT_SECRET --env staging
npx wrangler secret put OAUTH_STATE_SECRET --env staging
npx wrangler secret put IDENTITY_PROFILE_MAP --env staging
npx wrangler secret put CW_PROFILE_<ALIAS> --env staging
```

Required controls:

- `OAUTH_STATE_SECRET` has at least 32 random bytes.
- `IDENTITY_PROFILE_MAP` uses only immutable `<tid>:<oid>` keys and approved aliases.
- Each mapped alias has exactly one strict-JSON `CW_PROFILE_<ALIAS>` secret with a dedicated least-privilege ConnectWise API member.
- The secret list/names may be inspected by an independent operator; secret values must never be read back, logged, committed, or pasted into evidence.

## 7. Observability, acceptance, and rollback

Before allowing any real staging MCP use:

1. Restrict Worker log access/export and record retention/access owners in the secure operations record.
2. Configure alerts for sustained `failure`/`denied` audit outcomes and unexpected absence of audit events during known test traffic.
3. Execute every relevant item in [`v2-staging-acceptance-checklist.md`](v2-staging-acceptance-checklist.md), including six-user identity isolation, OAuth refresh/eligibility revocation, metadata-only ticket output, and ConnectWise permission-denial testing.
4. Retain only sanitized evidence references. Never commit log exports, token values, ticket IDs/text, request bodies, headers, profile JSON, or secrets.
5. Keep the Docker/FastAPI implementation as a restricted rollback path until the service owner, security owner, and ConnectWise owner approve cutover.

## Explicit stop points

Stop and obtain separate approval before any of the following:

- creating or deleting Cloudflare resources beyond the approved staging target;
- publishing a Worker, custom-domain routing, DNS/TLS changes, or changing `workers.dev` exposure;
- entering, rotating, or deleting secrets;
- configuring Entra redirect URIs, app roles, groups, or client credentials;
- setting ConnectWise origins/profiles, using ConnectWise credentials, or querying a ticket;
- changing audit retention/export access or alert delivery;
- production deployment, client onboarding, DNS/client cutover, or legacy rollback retirement.

See [`v2-foundation.md`](v2-foundation.md) for the enforced Worker security contract and [`v2-staging-acceptance-checklist.md`](v2-staging-acceptance-checklist.md) for the required acceptance evidence.
