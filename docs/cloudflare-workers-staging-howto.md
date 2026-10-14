# Cloudflare Workers V2 staging operator how-to

> **Purpose:** safely prepare and validate a Cloudflare Workers staging environment for ConnectWise MCP V2. This is an operator procedure, not production cutover authorization. It never authorizes secret disclosure, live ConnectWise access, DNS changes, or production deployment.

> **Remote variable source of truth:** staging policy variables are managed remotely. The `env.staging` block intentionally omits `vars`; deploy staging with `--keep-vars` so Wrangler preserves the approved remote values. The repository tests enforce that deployment-script flag. Wrangler does not support environment-specific `keep_vars` configuration, and enabling it globally would also change production behavior. Never add placeholder staging values to `wrangler.jsonc`, because explicitly configured values replace the live policy bindings.

## Boundaries and prerequisites

- Use an approved Cloudflare account and a staging-only Worker/KV target. Never reuse production KV namespaces or Worker secrets in staging.
- Use a dedicated staging Worker name and, initially, an account `workers.dev` hostname to avoid custom DNS changes. A custom domain needs its own explicit DNS/TLS approval.
- Run preparation from a reviewed release checkout in an environment that cannot access Cloudflare credentials or an authenticated Wrangler session. Dependency installation, lifecycle scripts, tests, and builds must finish before credentials are made available.
- Make approved operator authentication available only to narrowly scoped Cloudflare inspection, secret-management, or publish processes. For publishing, expose it only to the final direct integrity-wrapper invocation. Do not paste tokens, browser cookies, config files, account IDs, or secrets into chat, Git, PRs, shell history, screenshots, or this document.
- The implementation must remain fail-closed until all non-secret policy settings and secrets are intentionally entered. Do not make placeholder values functional by weakening authorization checks.

## 1. Inspect—do not mutate

The operator first validates the checkout with no Cloudflare credentials or authenticated Wrangler state available:

```bash
npm ci
npm run check
npx wrangler deploy --env staging --keep-vars --dry-run --outdir dist-staging
rm -rf dist-staging
```

Only after those commands finish may an authorized operator make the approved authentication available to a separate read-only inspection process:

```bash
npx wrangler whoami
npx wrangler kv namespace list
```

`npm run check` runs typechecking, tests, formatting, a moderate-or-higher npm audit, and explicit top-level and staging dry-runs. Pull-request CI additionally builds the production artifact and consumes it through the target-specific integrity wrapper without deployment or canonical-main ancestry claims. Only canonical `main` runs use the guarded production release path and retain release evidence. The staging dry-run validates only the local bundle and selected configuration path; it does not authenticate, inspect remote variables, validate their presence or values, or publish a Worker. `--keep-vars` protects remote variables when the same command is later run without `--dry-run`. Never run dependency installation, lifecycle scripts, tests, or builds in the credential-bearing deployment process.

Record account/operator and release evidence in an approved secure operations record. Do not put sensitive command output in Git.

Every successful canonical `main` `v2-ci` push, schedule, or manual run retains separate `v2-staging-release-<release-commit>` and `v2-production-release-<release-commit>` evidence artifacts for 90 days. Each contains the exact dry-run bundle, target manifest, reviewed `wrangler.jsonc`, locked npm dependency graph, canonical target-specific runtime inventory, and CycloneDX SBOM produced by that run. The strict schema-v5 manifest binds the bundle, configuration, package lock, and runtime inventory hashes and sizes; the inventory reproduces the manifest's length-prefixed runtime digest without retaining `node_modules`. GitHub attestations bind every retained file to the canonical repository and `.github/workflows/v2-ci.yml`. Before approving a release, verify the run succeeded on the exact full commit, download the target artifact without renaming files, and run `gh attestation verify` on all six files with the canonical repository, signer workflow, `refs/heads/main`, and full source digest constraints. Then run `npm run verify:v2-evidence -- <DOWNLOADED_DIRECTORY> <staging|production> <FULL_RELEASE_COMMIT>` from a reviewed repository checkout. That offline verifier requires no Git metadata, `node_modules`, or network access and fails closed on the file set, file types, release binding, manifest-bound bytes, runtime inventory digest/count, and CycloneDX structure. An expired artifact, failed run, pull-request run, unattested file, renamed/substituted file, failed offline verification, or local rebuild is not release evidence. Retention and attestation provide review evidence only; they do not authorize deployment or permit CI to receive Cloudflare credentials.

### Verify retained V2 release evidence

Use this exact procedure separately for the staging and production artifacts. Set `RELEASE_TARGET` to only `staging` or `production`; use the same successful canonical-main run ID and full commit for both runs:

```bash
set -euo pipefail
umask 077
reviewed_checkout=$PWD
RELEASE_TARGET='<staging-or-production>'
FULL_RELEASE_COMMIT='<approved-full-release-commit>'
SUCCESSFUL_MAIN_RUN_ID='<successful-main-v2-ci-run-id>'
[[ "$FULL_RELEASE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || exit 1
[[ "$SUCCESSFUL_MAIN_RUN_ID" =~ ^[1-9][0-9]*$ ]] || exit 1
case "$RELEASE_TARGET" in
  staging)
    manifest=staging-bundle-manifest.json
    inventory=staging-runtime-inventory.json
    sbom=connectwise-v2-staging.cdx.json
    ;;
  production)
    manifest=production-bundle-manifest.json
    inventory=production-runtime-inventory.json
    sbom=connectwise-v2-production.cdx.json
    ;;
  *) exit 1 ;;
esac
artifact_dir=$(mktemp -d "/tmp/connectwise-v2-${RELEASE_TARGET}-evidence.XXXXXXXX")
trap 'rm -rf -- "$artifact_dir"' EXIT
gh run download "$SUCCESSFUL_MAIN_RUN_ID" \
  --repo luckyludev/ConnectwiseMCP \
  --name "v2-${RELEASE_TARGET}-release-${FULL_RELEASE_COMMIT}" \
  --dir "$artifact_dir"
for artifact_file in \
  index.js \
  "$manifest" \
  "$inventory" \
  wrangler.jsonc \
  package-lock.json \
  "$sbom"
do
  gh attestation verify "$artifact_dir/$artifact_file" \
    --repo luckyludev/ConnectwiseMCP \
    --signer-workflow luckyludev/ConnectwiseMCP/.github/workflows/v2-ci.yml \
    --source-digest "$FULL_RELEASE_COMMIT" \
    --source-ref refs/heads/main
done
(
  cd "$reviewed_checkout"
  npm run verify:v2-evidence -- \
    "$artifact_dir" "$RELEASE_TARGET" "$FULL_RELEASE_COMMIT"
)
```

Every attestation must pass before the offline verifier runs. Keep the download in its private temporary directory, record only sanitized result references, and let the exit trap remove the files. A missing file, extra file, target mismatch, provenance mismatch, or offline-verification failure is a release stop condition; do not rename, copy in, regenerate, or edit evidence to make it pass.

## 2. Inventory and isolate staging OAuth storage

Namespaces are account-scoped, not domain-scoped. Before creating anything, inventory the approved Cloudflare account and the reviewed `env.staging` configuration:

```bash
npx wrangler kv namespace list
```

Confirm the `OAUTH_KV` namespace already bound in `wrangler.jsonc` is the approved **runtime** staging namespace. Do not create another runtime namespace or replace that binding merely because this procedure is being followed. Record only sanitized evidence in the secure operations record; do not paste namespace IDs into chat, tickets, or this repository.

The acceptance checklist also requires a distinct **preview** KV namespace/binding. The reviewed staging environment defines separate runtime and preview identifiers in `wrangler.jsonc`. Before deployment, an authorized operator must confirm that both identifiers belong to the approved staging-only namespaces and are distinct. Do not create or replace either namespace merely because this procedure is being followed.

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

Worker environments do **not** inherit KV bindings or `vars`. Keep the staging KV binding in the `staging` block, but keep the approved staging policy-variable values in the remote Worker configuration and deploy with `--keep-vars`. Keep production placeholders and production bindings separate. CI pins the staging Worker name, Workers.dev-only exposure, absence of DNS routes, deployment-script flags, remote-variable omission, and KV-isolation contract.

## 3. Establish the literal canonical staging resource

For a Workers.dev staging Worker named `connectwise-mcp-v2-staging`, the canonical resource is exactly:

```text
https://connectwise-mcp-v2-staging.<workers-dev-subdomain>.workers.dev/mcp
```

The value must be literal and canonical: HTTPS only; `/mcp` path included; no redirect, credentials, query, fragment, port, or trailing-slash variation. Set the remote staging `MCP_CANONICAL_URL` before first publish. A syntactically invalid value can prevent Worker-isolate initialization, while a parseable but noncanonical value may still publish. The request entry point rejects every request when the runtime value is noncanonical, before OAuth-provider handling or ConnectWise profile access; a successful publish therefore does not prove that this setting is valid.

Configure these non-secret keys remotely through the approved Cloudflare workflow: `MCP_CANONICAL_URL`, `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `ALLOWED_GROUP_IDS`, `ALLOWED_APP_ROLES`, `ALLOWED_CLIENT_REDIRECT_URIS`, and `CONNECTWISE_ALLOWED_ORIGINS`. Do not copy their live values into the repository.

Empty eligibility lists and absent secrets must remain fail-closed. Do not deploy an Entra/ConnectWise-capable service until the separate approvals below are complete.

## 4. Review and publish the fail-closed staging Worker

A configuration change requires the normal repository review and CI process. Once the target release is merged, fetch the canonical `origin` remote, record the merged release's full lowercase 40-character commit SHA in the approved release evidence, and do not move or synthesize the local `origin/main` tracking ref. An authorized operator must use a dedicated checkout with no concurrent writers, check out that exact commit with a clean worktree, and explicitly supply the recorded SHA. First prepare and verify the bundle in a process that cannot access Cloudflare credentials or authenticated Wrangler state:

```bash
STAGING_RELEASE_SHA=<approved-full-release-commit> npm run prepare:staging
```

After preparation succeeds, record the printed bundle, configuration, and deployment-runtime SHA-256 digests in the approved operations record. Do not recompute or derive them in the credential-bearing process. Make approved operator authentication available only to a separate process that publishes the already verified staging bundle, supplying those independently retained values as `STAGING_BUNDLE_SHA256`, `STAGING_CONFIG_SHA256`, and `STAGING_DEPLOY_RUNTIME_SHA256`. Start that process from a clean environment with no Cloudflare endpoint/account, Wrangler logging, proxy, or TLS/CA override variables set; the launcher rejects even empty overrides rather than allowing credentials to follow inherited routing or trust settings. Record an operator-approved absolute path to a regular, non-symlink Node executable as `DEPLOY_NODE_PATH`; do not derive it with `which`, `command -v`, or another `PATH` lookup in the credential-bearing shell. Invoke the reviewed executable launcher directly so npm cannot run pre/post lifecycle hooks and inherited environment overrides are rejected before Node can access deployment credentials:

```bash
DEPLOY_NODE_PATH=/absolute/path/to/reviewed/node \
STAGING_RELEASE_SHA=<approved-full-release-commit> \
STAGING_BUNDLE_SHA256=<approved-bundle-sha256> \
STAGING_CONFIG_SHA256=<approved-configuration-sha256> \
STAGING_DEPLOY_RUNTIME_SHA256=<approved-deployment-runtime-sha256> \
  scripts/deploy-verified-bundle.sh
```

The preparation command fails before validation unless `STAGING_RELEASE_SHA` exactly matches `HEAD`, `origin` names the canonical GitHub repository, no Git URL-rewrite or legacy graft metadata can redirect or alter verification, a fresh fetch of its `main` branch succeeds, the release commit is contained in that fetched review boundary with Git replacement objects disabled, the checkout is the repository root, the index matches the approved commit, every tracked file's raw bytes and executable mode match that index independently of Git filters or stat caches, no tracked file uses `skip-worktree` or `assume-unchanged`, the non-ignored untracked worktree state is clean, and no implicit Wrangler `.env` variant exists. It discards the existing dependency tree and runs `npm ci` so deployment tooling is restored from the integrity-protected lockfile, runs the complete blocking `npm run check` suite, creates a strict manifest that binds the generated regular, non-symlink, single-link `dist/index.js` bytes, reviewed configuration, and installed deployment-runtime tree to the checked-out commit, and repeats the release/worktree guard after the build. The credential-bearing launcher is the mandatory pre-Node boundary: it fails closed if Node preload/module-path, Cloudflare endpoint/account, Wrangler logging, proxy, or TLS/CA override variables are present, requires `DEPLOY_NODE_PATH` to identify an approved absolute regular, non-symlink executable, then removes every guarded variable before starting that exact Node binary. The integrity wrapper independently rejects Cloudflare endpoint/account, Wrangler logging, proxy, and TLS/CA overrides if its deploy action is invoked directly, removes those variables plus Node injection variables from Wrangler's environment as defense in depth, and invokes the verified Wrangler entry point through the already-running approved Node executable rather than its `PATH`-sensitive shebang. Direct Node invocation cannot reject a preload before Node starts and is not an approved credential-bearing deployment path. The credential-bearing deployment command runs no Git or npm subprocess, dependency installation, lifecycle script, test, or build. It requires the independently retained bundle, configuration, and deployment-runtime digests and rejects a missing, replaced, modified, differently bound, or checkout-escaping runtime artifact before invoking Wrangler. Stable npm-created hardlinks and internal package symlinks are accepted during preparation; the wrapper copies their verified bytes and links into a private runtime snapshot, breaking hardlink aliases, and executes only that snapshot. It also copies the verified bundle and configuration bytes to private paths, removes write permission while Wrangler consumes them, supplies a private empty `--env-file` explicitly, and rechecks the private copies before cleanup. The empty file prevents ignored checkout files from changing the deployment account or credential; approved operator authentication still comes from the invoking process environment. It preserves approved remote variables and strict mode, and Cloudflare retains the deployed version for separately authorized rollback. If validation fails or Wrangler reports conflicting remote changes, stop and review the drift; do not bypass the release guard, integrity wrapper, or `--strict`.

This creates or updates the staging Worker and its Workers.dev endpoint. The integrity wrapper labels the deployed Worker version with the exact verified `STAGING_RELEASE_SHA` as its Wrangler tag and includes that SHA in the version message. Record the returned Worker version ID in the secure operations record, then use the approved Cloudflare read-only workflow to confirm that version's tag exactly equals the approved full release SHA. A missing or mismatched tag blocks acceptance. The deployment does not create a custom-domain route.

OAuth flow state is an encrypted, ten-minute, version-local artifact. Deploy this state-format change only to a target with no active authorization flows; do not use a gradual/canary rollout that mixes Worker versions. On rollback, in-flight authorization and callback URLs fail closed and users must restart OAuth against the restored version. Never add a legacy signed-state reader to preserve in-flight flows, because that would restore disclosure of the browser-binding nonce and upstream PKCE verifier.

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

Then set only the approved staging values in the remote Worker configuration through the approved Cloudflare workflow:

- `ENTRA_TENANT_ID`
- `ENTRA_CLIENT_ID`
- non-empty `ALLOWED_GROUP_IDS` and/or `ALLOWED_APP_ROLES`
- `ALLOWED_CLIENT_REDIRECT_URIS` containing only exact approved HTTPS callbacks (or explicitly approved loopback paths)
- `CONNECTWISE_ALLOWED_ORIGINS`, a JSON array of exact canonical approved ConnectWise HTTPS origins

Do not add names, email addresses, ticket identifiers, raw URLs with paths, localhost/IP origins, or caller-selectable endpoints. Identity-to-profile selection remains an immutable Entra `<tid>:<oid>` mapping stored as a secret.

## 6. Enter secrets interactively after separate approval

Only an authorized operator should enter secrets using Wrangler’s secure prompt or an approved Cloudflare secret-management workflow. Never put a secret value on the command line or in a redirected shell pipeline.

```bash
DEPLOY_NODE_PATH=/absolute/path/to/reviewed/node scripts/put-staging-secret.sh ENTRA_CLIENT_SECRET
DEPLOY_NODE_PATH=/absolute/path/to/reviewed/node scripts/put-staging-secret.sh OAUTH_STATE_SECRET
DEPLOY_NODE_PATH=/absolute/path/to/reviewed/node scripts/put-staging-secret.sh IDENTITY_PROFILE_MAP
DEPLOY_NODE_PATH=/absolute/path/to/reviewed/node scripts/put-staging-secret.sh CW_PROFILE_LUIS
```

The launcher rejects inherited Node preload, Wrangler logging, Cloudflare API-endpoint, account-routing, proxy, and TLS overrides; permits only the documented staging secret names or a valid ASCII `CW_PROFILE_<ALIAS>` binding; and cannot select production or forward arbitrary Wrangler arguments. Run it from the reviewed repository root; it resolves that physical directory, pins its reviewed `wrangler.jsonc` explicitly, and accepts only its non-symlink launcher and lock-installed Wrangler path components. `DEPLOY_NODE_PATH` must identify the reviewed absolute, canonical, regular executable through a path with no symlink components.

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
5. Complete and rehearse the parameterized [`cutover-rollback-runbook.md`](cutover-rollback-runbook.md). Keep the Docker/FastAPI implementation as a restricted rollback path until V2 passes the approved production monitoring period and the service owner, security owner, and ConnectWise owner separately approve retirement; no cutover may proceed without approved numeric triggers, a decision authority, RTO, legacy health proof, and sanitized rehearsal evidence.

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
