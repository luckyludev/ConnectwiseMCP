# Worker V2 cutover and rollback runbook

> **Operator-controlled procedure:** this document defines required decisions and evidence; it does not authorize deployment, DNS, Cloudflare or Entra changes, secret access, ConnectWise access, or production cutover. Authorized operators must substitute approved values in a secure change record. Never put tokens, credentials, profile JSON, ticket IDs, raw responses, or sensitive logs in this repository or a pull request.

## 1. Required change record

Before the change window, record these non-secret references in the approved operations system:

- immutable, reviewed V2 release commit and successful CI run;
- production V2 Worker target and canonical MCP URL;
- legacy Docker/FastAPI rollback endpoint and last verified rollback-image commit/digest;
- change window, monitoring window, support contacts, incident commander, and the single rollback decision authority;
- Cloudflare, Entra, ConnectWise, service, and security operators needed for the window;
- approved client/DNS routing mechanism, exact ordered cutback sequence, cutover and recovery cohort definitions, and documented propagation or cache behavior;
- numeric rollback triggers, maximum decision time, rollback recovery-time objective (RTO), maximum rollback duration, cohort observation intervals, legacy health thresholds, stabilization interval, and the escalation/outage action required when any deadline is exceeded;
- sanitized references to staging acceptance, legacy health, rollback rehearsal, and backup/configuration records.

A missing owner, evidence reference, approved threshold, or required operator is a stop condition. Do not invent values during the change window.

## 2. Measurable rollback triggers

The service and security owners must approve numeric thresholds before cutover. Define a bounded evaluation window and data source for every threshold. At minimum, define:

| Signal                                               | Required threshold                                                     |
| ---------------------------------------------------- | ---------------------------------------------------------------------- |
| Authentication or token-exchange failure rate        | percentage and minimum sample count over a stated interval             |
| MCP request failure rate or latency                  | percentage/percentile and duration                                     |
| Missing audit events                                 | maximum count or elapsed time during known traffic                     |
| Cross-user profile isolation                         | zero tolerance; any confirmed mismatch triggers immediate rollback     |
| Secret, token, credential, or business-data exposure | zero tolerance; stop traffic and invoke the incident procedure         |
| ConnectWise permission behavior                      | count/rate showing unexpected broad access or denial of approved reads |
| Client reachability                                  | minimum successful clients/identities over a stated interval           |

The rollback authority may roll back before a threshold is crossed when evidence indicates an active security or data-isolation incident. Do not weaken Entra eligibility, ConnectWise roles, profile mapping, output bounds, or audit controls to avoid rollback.

### Verified rollback image artifact

Every successful canonical `main` run of `legacy-oauth-ci` retains `legacy-rollback-image-<release-commit>` for 90 days. The artifact contains the exact image archive that CI reloaded and smoke-tested, its SHA-256 checksum, a CycloneDX SBOM generated from that image, and a manifest binding both the archive and SBOM digests plus the image ID to the workflow commit and run. GitHub artifact attestations cryptographically bind all four files to the canonical repository and workflow identity. A pull-request merge commit, a failed run, an expired artifact, an unattested file, or a local rebuild is not rollback evidence.

Before the change window, select a successful `push`, `schedule`, or manually dispatched run on `refs/heads/main` whose full 40-character `headSha` is the reviewed release commit. Record its run URL/ID in the approved operations system. Download the artifact without renaming its files:

```bash
set -euo pipefail
gh run download <SUCCESSFUL_MAIN_RUN_ID> \
  --repo luckyludev/ConnectwiseMCP \
  --name legacy-rollback-image-<FULL_RELEASE_COMMIT> \
  --dir rollback-image-<FULL_RELEASE_COMMIT>
cd rollback-image-<FULL_RELEASE_COMMIT>
for artifact_file in \
  connectwise-legacy-rollback-image.tar.gz \
  connectwise-legacy-rollback-image.sha256 \
  connectwise-legacy-rollback-image.json \
  connectwise-legacy-rollback-image.cdx.json
do
  gh attestation verify "$artifact_file" \
    --repo luckyludev/ConnectwiseMCP \
    --signer-workflow luckyludev/ConnectwiseMCP/.github/workflows/legacy-oauth-ci.yml \
    --source-digest <FULL_RELEASE_COMMIT> \
    --source-ref refs/heads/main
done
python3 <REVIEWED_REPOSITORY_CHECKOUT>/deploy/http-gateway/tests/verify_rollback_artifact.py \
  . <FULL_RELEASE_COMMIT> <SUCCESSFUL_MAIN_RUN_ID>
```

Each `gh attestation verify` command must pass against the canonical repository, signer workflow, release commit, and `refs/heads/main`; this rejects substituted or locally rebuilt files even when their filenames match. The local verifier then fails closed unless the artifact directory itself is a real directory, the manifest has the exact schema and expected release/run bindings, the four fixed artifact filenames are regular non-symlink single-link files, the image repository and image ID are valid, the checksum file has the exact expected syntax, the downloaded archive and bounded CycloneDX SBOM match their manifest SHA-256 digests, and the SBOM contains a component inventory. It opens the directory and files without following symlinks and keeps every validation/read bound to the same file descriptors, rejecting metadata changes observed during a read. Do not edit, rename, symlink, or hard-link the artifact directory or files to make verification pass, and do not continue when any provenance or local verification check fails.

Load and verify the tested image before rehearsal and preflight:

```bash
gzip -dc connectwise-legacy-rollback-image.tar.gz | docker load
expected_image_id=$(python3 -c 'import json; print(json.load(open("connectwise-legacy-rollback-image.json", encoding="utf-8"))["imageId"])')
test "$(docker image inspect --format '{{.Id}}' connectwise-legacy-rollback-ci)" = "$expected_image_id"
```

The Compose file uses a separate `connectwise-legacy-rollback-local` tag for ordinary local builds. Rollback must stop and verify the existing tunnel is stopped, then use the loaded CI tag, start only the gateway, and prohibit rebuilds and pulls:

```bash
cd <REVIEWED_REPOSITORY_CHECKOUT>/deploy/http-gateway
export MCP_GATEWAY_IMAGE=connectwise-legacy-rollback-ci
docker compose stop cloudflared || exit 1
if [ "$(docker inspect --format '{{.State.Running}}' connectwise-mcp-cloudflared 2>/dev/null || printf 'false')" != "false" ]; then
  exit 1
fi
docker compose up -d --no-build --pull never mcp-gateway
actual_image_id=$(docker inspect --format '{{.Image}}' connectwise-mcp-gateway)
if [ "$actual_image_id" != "$expected_image_id" ]; then
  docker compose stop mcp-gateway
  exit 1
fi
docker compose up -d --no-build --pull never cloudflared
```

The image-ID comparison must pass before starting the tunnel or routing any client. If it fails, immediately stop the gateway and investigate; do not retag, rebuild, or continue. Confirm the digest-pinned `cloudflared` image is available before the window. Do not use `--build`, retag a different image as `connectwise-legacy-rollback-ci`, or allow Compose to substitute another gateway image. If the artifact will expire before the monitoring window ends, manually dispatch `legacy-oauth-ci` against the unchanged reviewed `main` commit or retain the verified files in the approved artifact system before expiry; reverify the successful run's `headSha`, checksum, manifest, and loaded image ID afterward.

## 3. Preflight gate

### Production release artifact gate

Production deployment is an operator-only action after the change record, release approval, staging acceptance, rollback evidence, and change window are all approved. CI and ordinary `npm run check` must never run `npm run deploy:production`; they may only exercise dry-run builds and verified dry-run consumption. Do not provide live Cloudflare credentials to CI for this path.

From a fresh, dedicated checkout of the approved canonical `origin/main` commit, with no `.env`, `.env.local`, `.env.production`, or `.env.production.local` file, perform the non-deploying preparation exactly as follows. `<FULL_RELEASE_COMMIT>` must be the approved 40-character lowercase commit, not a branch, abbreviated SHA, or mutable tag:

```bash
git remote get-url origin
git fetch --no-tags origin main
git checkout --detach <FULL_RELEASE_COMMIT>
export PRODUCTION_RELEASE_SHA=<FULL_RELEASE_COMMIT>
node scripts/verify-staging-release.mjs production
npm ci
npm run check
node scripts/verify-staging-release.mjs production
npm run dry-run:production
```

The production guard fetches the canonical repository itself and fails unless tracked and non-ignored content is clean, the listed implicit Wrangler environment files are absent, the checkout exactly matches `PRODUCTION_RELEASE_SHA`, and that commit is contained in canonical `origin/main`. Ignored dependency and generated-output directories may exist so that the guard can be repeated after the build; the manifest binds the consumed bundle, configuration, and complete installed deployment-runtime tree. The production build uses the top-level `wrangler.jsonc` target without `--env staging` and explicitly supplies the reviewed, empty `config/empty.env` so Wrangler cannot load implicit environment files. It creates `dist/production-bundle-manifest.json` and binds the generated bundle, reviewed configuration, installed runtime, and immutable commit. The verified dry run gives Wrangler only private read-only bundle and configuration copies, an explicit empty environment file, `--keep-vars --strict`, and the full commit as both the tag and part of the release message; it rejects deployment-runtime changes before invocation, verifies the private copies after Wrangler returns, and removes them. Any guard, build, manifest, dry-run, cleanup, or tamper-check failure is a stop condition. Any future production publisher must separately require independently retained `PRODUCTION_BUNDLE_SHA256`, `PRODUCTION_CONFIG_SHA256`, and `PRODUCTION_DEPLOY_RUNTIME_SHA256` values before credentials are exposed.

Record sanitized evidence of the successful commands and independently confirm that the manifest's `releaseCommit` is the approved value. Do not edit or recreate the manifest. This repository intentionally does **not** expose a `deploy:production` package script while the reviewed top-level configuration still contains production placeholders. The integrity utility also rejects `deploy production` directly, so a locally generated manifest cannot bypass that gate.

Enabling production deployment now requires reviewed live configuration input: replace the top-level production KV, canonical URL, Entra identifiers, and authorization/origin policy placeholders with the approved values without committing secrets, then add a focused deployment command that re-runs the canonical clean-release guard inside the credential-bearing action. That future command must not run dependency installation, tests, lifecycle scripts, or general builds while live Cloudflare credentials are present. It must be separately reviewed and exercised first as a non-deploying dry run. Until that change merges and the deployment approval is explicitly reconfirmed, stop after `npm run dry-run:production`; do not use direct `wrangler deploy` as a workaround.

Complete immediately before routing production clients:

1. Verify the candidate commit is the exact reviewed commit and all required checks passed on it.
2. Confirm the staging acceptance completion record is approved, including all six mapped identities, negative authorization cases, concurrent isolation, bounded read results, ConnectWise permission denial, and audit review.
3. Confirm V2 configuration names and counts against the approved record without reading secret values. Confirm production and staging resources are distinct.
4. Confirm current V2 health and OAuth/MCP discovery using approved non-sensitive probes. Do not run live write tools.
5. Confirm the legacy rollback endpoint is access-restricted and healthy. Use its authenticated health/smoke procedure without printing credentials or response bodies.
6. Confirm the rollback image matches the reviewed digest and can start without fetching a floating image or dependency.
7. Confirm monitoring dashboards, alert delivery, log access restrictions, on-call coverage, and the incident channel are active.
8. Record the preflight timestamp and sanitized pass/fail evidence references.

If any preflight item fails, abort cutover. Leave production routing unchanged and open remediation against a new reviewed release commit.

## 4. Controlled cutover

Only authorized infrastructure operators perform these steps:

1. Announce the start and freeze unrelated production, Entra, Cloudflare, ConnectWise-role, and client-configuration changes.
2. Capture the current routing/client configuration in the approved secure system so it can be restored exactly. Do not export secrets into the change record.
3. Route the smallest approved client cohort to V2 using the approved mechanism. Do not retire or broaden access to the legacy endpoint.
4. Run only the approved bounded read probes for that cohort. Verify identity-to-profile alias, expected authorization, response projection, and exactly one secret-free audit event per exercised tool invocation.
5. Observe the approved interval. Compare every rollback signal to its recorded threshold.
6. Expand cohorts only after the prior cohort has a recorded pass. Stop expansion on an ambiguous result.
7. When all approved cohorts pass, begin the full monitoring window. Keep legacy rollback capacity intact and restricted.

Never use a live write-capable tool unless its separate issuance policy, operation-specific test, cleanup plan, and change approval have passed. The current release does not issue `mcp:write`.

## 5. Rollback decision and cutback

When a trigger is met, or the rollback authority directs cutback, begin immediately. If the approved maximum decision time expires without a decision, escalate to the incident commander and invoke the approved outage procedure; do not continue cohort expansion by default.

1. Record the decision time, triggering signal, and sanitized evidence reference. Declare an incident for any security, isolation, or data-exposure trigger.
2. Stop cohort expansion and prevent new clients from reaching V2 using the approved routing/client mechanism. Do not delete V2 resources or secrets; preserve evidence.
3. Confirm the legacy gateway and tunnel are access-restricted and healthy before changing any routing or client configuration. If legacy health fails, stop and invoke the approved outage procedure; never direct clients to an unhealthy target.
4. Restore the captured legacy routing/client configuration only for the smallest approved recovery cohort, following the exact cutback order recorded before the change window and accounting for propagation/cache behavior.
5. Run the cohort's authenticated, non-mutating legacy smoke checks.
6. Expand recovery cohorts only after successful probes and the approved observation interval. Verify client reachability and expected legacy authentication behavior after each expansion.
7. Confirm V2 no longer receives ordinary client traffic, except explicitly approved diagnostic probes, and retain its restricted logs for incident analysis.
8. Record restoration time and whether the approved rollback RTO was met. If the RTO or maximum rollback duration is exceeded, escalate immediately and invoke the approved outage procedure rather than continuing an unbounded cutback.

The legacy gateway is a temporary, restricted emergency path with shared-credential and broad-tool limitations. Keep perimeter controls and monitoring active; never treat rollback as acceptance of those limitations for steady-state production.

## 6. Post-cutback acceptance and abort criteria

Rollback is successful only when all of the following are true:

- the approved recovery cohorts can reach legacy and complete the bounded non-mutating smoke checks;
- production clients no longer depend on V2 routing;
- authentication and request health remain within the legacy thresholds for the full stabilization interval;
- no unauthorized broadening of perimeter, Entra, ConnectWise, or credential access occurred;
- incident evidence and timestamps are retained only in approved systems, with repository-safe references where needed.

Abort the recovery expansion and invoke the outage procedure if legacy health fails, required credentials/operators are unavailable, routing state is uncertain, or a security/data-isolation trigger remains active. Do not alternate targets repeatedly without a new explicit decision from the rollback authority.

## 7. Forward recovery and legacy retirement gate

After rollback:

1. Keep V2 isolated while owners determine root cause. Rotate affected credentials or remove identity eligibility when required by the incident procedure.
2. Fix the issue through a new focused commit, review, CI run, and staging acceptance cycle. Do not redeploy an unreviewed local patch.
3. Rehearse this runbook again if routing, authentication, profile mapping, rollback packaging, or monitoring changed.
4. Schedule a new approved change window; do not resume the failed window informally.
5. Retain the legacy rollback path until V2 has passed the approved production monitoring period and the service, security, and ConnectWise owners explicitly approve retirement.
6. Retire legacy access, credentials, tunnel/routing, and stored artifacts only under a separate reviewed change with verification that no client still depends on them.

## 8. Rehearsal evidence

Before production cutover, conduct a non-production rehearsal with no real secrets or production ConnectWise data. The rehearsal must pass every preflight, cutback, recovery-cohort, and post-cutback check and meet the approved RTO. A failed or late rehearsal blocks cutover until remediation is reviewed and the rehearsal passes on the resulting candidate. Record in the approved system:

- rehearsal date, environment, release and rollback image commits/digests;
- participants and decision authority;
- simulated trigger and decision time;
- cutback start/end times and measured RTO;
- preflight, legacy health, recovery-cohort, and post-cutback results;
- failures, remediation owner, and the release commit that closes each failure.

A rehearsal does not satisfy live Entra, Cloudflare, ConnectWise, audit, six-user isolation, or production approval gates in the staging acceptance checklist.
