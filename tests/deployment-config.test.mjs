import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";

import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";

async function readJson(relativePath) {
  const path = new URL(relativePath, import.meta.url);
  return JSON.parse(await readFile(path, "utf8"));
}

async function readWranglerConfig() {
  const path = new URL("../wrangler.jsonc", import.meta.url);
  const source = await readFile(path, "utf8");
  const errors = [];
  const config = parse(source, errors, { allowTrailingComma: true });

  expect(errors).toEqual([]);
  return config;
}

describe("dependency maintenance configuration", () => {
  it("covers maintained dependency surfaces without unsafe Python lock updates", async () => {
    const [source, v2Workflow, legacyWorkflow] = await Promise.all([
      readFile(new URL("../.github/dependabot.yml", import.meta.url), "utf8"),
      readFile(
        new URL("../.github/workflows/v2-ci.yml", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../.github/workflows/legacy-oauth-ci.yml", import.meta.url),
        "utf8",
      ),
    ]);
    const entries = [
      ...source.matchAll(
        /  - package-ecosystem: "([^"]+)"\n    directory: "([^"]+)"/gu,
      ),
    ].map((match) => ({ ecosystem: match[1], directory: match[2] }));

    expect(source).toMatch(/^version: 2$/mu);
    expect(entries).toEqual([
      { ecosystem: "npm", directory: "/" },
      { ecosystem: "npm", directory: "/deploy/cwm-mcp" },
      { ecosystem: "github-actions", directory: "/" },
      { ecosystem: "docker", directory: "/deploy/http-gateway" },
      { ecosystem: "docker-compose", directory: "/deploy/http-gateway" },
    ]);
    expect(source.match(/interval: "weekly"/gu)).toHaveLength(5);
    expect(source.match(/timezone: "America\/New_York"/gu)).toHaveLength(5);
    expect(source).not.toContain('package-ecosystem: "pip"');
    expect(v2Workflow.match(/- "config\/\*\*"/gu)).toHaveLength(1);
    expect(v2Workflow.match(/- "\.github\/dependabot\.yml"/gu)).toHaveLength(1);
    expect(
      legacyWorkflow.match(/- "\.github\/dependabot\.yml"/gu),
    ).toHaveLength(1);
    expect(legacyWorkflow).toContain("node-version: 24.11.0");
  });

  it("keeps the legacy rollback lock above the multidict security floor", async () => {
    const [input, lock] = await Promise.all([
      readFile(
        new URL("../deploy/http-gateway/requirements.txt", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../deploy/http-gateway/requirements.lock", import.meta.url),
        "utf8",
      ),
    ]);
    const lockedVersion = lock.match(/^multidict==(\d+)\.(\d+)\.(\d+)/mu);

    expect(input).toMatch(/^multidict>=6\.9\.1$/mu);
    expect(lockedVersion).not.toBeNull();
    expect(lockedVersion.slice(1).map(Number)).toEqual(
      expect.arrayContaining([expect.any(Number)]),
    );
    expect(
      lockedVersion
        .slice(1)
        .map(Number)
        .reduce((result, part, index) => result || part - [6, 9, 1][index], 0),
    ).toBeGreaterThanOrEqual(0);
  });

  it("installs legacy CI tooling only from a reproducible hash lock", async () => {
    const [workflow, input, lock] = await Promise.all([
      readFile(
        new URL("../.github/workflows/legacy-oauth-ci.yml", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../deploy/http-gateway/requirements-ci.in", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../deploy/http-gateway/requirements-ci.lock", import.meta.url),
        "utf8",
      ),
    ]);

    expect(input.trim().split("\n")).toEqual([
      "uv==0.12.0",
      "pytest==9.1.1",
      "ruff==0.16.1",
      "pip-audit==2.10.1",
    ]);
    for (const dependency of input.trim().split("\n")) {
      expect(lock).toContain(`${dependency} \\`);
    }
    expect(lock).toContain("--hash=sha256:");
    expect(workflow).toContain("deploy/http-gateway/requirements-ci.lock");
    expect(workflow).toContain(
      "uv pip compile deploy/http-gateway/requirements-ci.in --python-version 3.12 --generate-hashes --no-emit-index-url --output-file deploy/http-gateway/requirements-ci.lock",
    );
    expect(workflow).toContain(
      "git diff --exit-code -- deploy/http-gateway/requirements-ci.lock deploy/http-gateway/requirements.lock",
    );
    expect(workflow).toContain(
      "pip-audit -r deploy/http-gateway/requirements-ci.lock",
    );
    const pipInstalls = workflow.match(/^\s*python -m pip install.*$/gmu) ?? [];
    expect(pipInstalls).toHaveLength(2);
    for (const command of pipInstalls) {
      expect(command).toContain("--require-hashes");
    }
  });
});

describe("legacy rollback deployment surface", () => {
  it("allows only the CI-verified Docker/FastAPI rollback descriptors", async () => {
    const [deploymentFiles, legacyWorkflow, v2Workflow] = await Promise.all([
      readdir(new URL("../deploy/", import.meta.url), { recursive: true }),
      readFile(
        new URL("../.github/workflows/legacy-oauth-ci.yml", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../.github/workflows/v2-ci.yml", import.meta.url),
        "utf8",
      ),
    ]);
    const descriptors = deploymentFiles
      .filter((path) =>
        /(?:^|\/)(?:Dockerfile(?:\..+)?|Containerfile(?:\..+)?|(?:docker-)?compose(?:\..+)?\.ya?ml)$/u.test(
          path,
        ),
      )
      .sort();

    expect(descriptors).toEqual([
      "http-gateway/Dockerfile",
      "http-gateway/docker-compose.yml",
    ]);
    expect(legacyWorkflow.match(/- "deploy\/\*\*"/gu)).toHaveLength(1);
    expect(v2Workflow.match(/- "deploy\/\*\*"/gu)).toHaveLength(1);
    expect(
      v2Workflow.match(/- "\.github\/workflows\/legacy-oauth-ci\.yml"/gu),
    ).toHaveLength(1);

    const legacyPushTrigger = legacyWorkflow.match(
      /^  push:\n(?<body>(?:    [^\n]*\n)*)/mu,
    );
    expect(legacyPushTrigger?.groups?.body).toBe("    branches: [main]\n");
    expect(legacyWorkflow).toContain(
      "group: legacy-oauth-ci-${{ github.event_name }}-${{ github.event_name == 'push' && github.sha || github.ref }}",
    );

    const v2PushTrigger = v2Workflow.match(
      /^  push:\n(?<body>(?:    [^\n]*\n)*)/mu,
    );
    expect(v2PushTrigger?.groups?.body).toBe("    branches: [main]\n");
    expect(v2Workflow).toContain(
      "group: v2-ci-${{ github.event_name }}-${{ github.event_name == 'push' && github.sha || github.ref }}",
    );
  });

  it("keeps local legacy credential artifacts out of version control", () => {
    for (const path of [
      "deploy/cwm-mcp/credentials.json",
      "deploy/http-gateway/local-credentials.json",
    ]) {
      const result = spawnSync("git", ["check-ignore", "--verbose", path], {
        cwd: new URL("../", import.meta.url),
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trimEnd().endsWith(`\t${path}`)).toBe(true);
    }
  });

  it("blocks accidental publication of the legacy rollback package", async () => {
    const [legacyPackage, deploymentFiles] = await Promise.all([
      readJson("../deploy/cwm-mcp/package.json"),
      readdir(new URL("../deploy/", import.meta.url), { recursive: true }),
    ]);
    const nestedWorkflows = deploymentFiles.filter((path) =>
      /(?:^|\/)\.github\/workflows\//u.test(path),
    );

    expect(legacyPackage.private).toBe(true);
    expect(legacyPackage.scripts?.prepublishOnly).toBe(
      "node -e \"process.exitCode=1; console.error('Legacy rollback package is not publishable')\"",
    );
    expect(nestedWorkflows).toEqual([]);
  });
});

describe("legacy rollback image security", () => {
  it("smoke-tests the digest-pinned cloudflared image rendered from Compose", async () => {
    const [workflow, compose] = await Promise.all([
      readFile(
        new URL("../.github/workflows/legacy-oauth-ci.yml", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../deploy/http-gateway/docker-compose.yml", import.meta.url),
        "utf8",
      ),
    ]);
    const imagePattern = /cloudflare\/cloudflared:latest@sha256:[0-9a-f]{64}/gu;

    expect(compose.match(imagePattern)).toHaveLength(1);
    expect(workflow.match(imagePattern)).toBeNull();
    expect(workflow).toContain(
      'cloudflared_image="$(python -c \'import json, sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["services"]["cloudflared"]["image"])\' /tmp/rollback-compose.json)"',
    );
    expect(workflow).toContain('docker pull "$cloudflared_image"');
    expect(workflow).toContain(
      'docker run --rm --cap-drop ALL --security-opt no-new-privileges:true "$cloudflared_image" --version',
    );
  });

  it("fails CI on severe findings and retains the exact smoke-tested image", async () => {
    const [workflow, dockerfile, compose] = await Promise.all([
      readFile(
        new URL("../.github/workflows/legacy-oauth-ci.yml", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../deploy/http-gateway/Dockerfile", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../deploy/http-gateway/docker-compose.yml", import.meta.url),
        "utf8",
      ),
    ]);
    const buildOffset = workflow.indexOf("- name: Build rollback image");
    const scanOffset = workflow.indexOf(
      "- name: Scan rollback image for fixable severe vulnerabilities",
    );
    const sbomOffset = workflow.indexOf(
      "- name: Generate rollback image CycloneDX SBOM",
    );
    const contentValidationOffset = workflow.indexOf(
      "- name: Verify allowlisted rollback image contents",
    );
    const packageOffset = workflow.indexOf(
      "- name: Package the verified rollback image",
    );
    const verifyArtifactOffset = workflow.indexOf(
      "- name: Verify packaged rollback artifact bindings and checksum",
    );
    const reloadOffset = workflow.indexOf(
      "- name: Reload the verified rollback image",
    );
    const smokeOffset = workflow.indexOf(
      "- name: Smoke-test packaged rollback image startup and auth boundary",
    );
    const retainOffset = workflow.indexOf(
      "- name: Retain the verified rollback image",
    );
    const attestJobOffset = workflow.indexOf("\n  attest:\n");
    const downloadOffset = workflow.indexOf(
      "- name: Download the verified rollback artifact",
    );
    const attestOffset = workflow.indexOf(
      "- name: Attest the verified rollback artifact",
    );
    const retainStep = workflow.slice(retainOffset, attestJobOffset);
    const attestJob = workflow.slice(attestJobOffset);
    const attestStep = workflow.slice(attestOffset);
    const artifactFiles = [
      "connectwise-legacy-rollback-image.tar.gz",
      "connectwise-legacy-rollback-image.sha256",
      "connectwise-legacy-rollback-image.json",
      "connectwise-legacy-rollback-image.cdx.json",
    ];

    expect(buildOffset).toBeGreaterThan(-1);
    expect(scanOffset).toBeGreaterThan(buildOffset);
    expect(sbomOffset).toBeGreaterThan(scanOffset);
    expect(contentValidationOffset).toBeGreaterThan(sbomOffset);
    expect(packageOffset).toBeGreaterThan(contentValidationOffset);
    expect(verifyArtifactOffset).toBeGreaterThan(packageOffset);
    expect(reloadOffset).toBeGreaterThan(verifyArtifactOffset);
    expect(smokeOffset).toBeGreaterThan(reloadOffset);
    expect(retainOffset).toBeGreaterThan(smokeOffset);
    expect(attestJobOffset).toBeGreaterThan(retainOffset);
    expect(downloadOffset).toBeGreaterThan(attestJobOffset);
    expect(attestOffset).toBeGreaterThan(downloadOffset);
    expect(workflow).toMatch(/^permissions:\n  contents: read$/mu);
    expect(attestJob).toMatch(
      /^  attest:\n    needs: verify\n    if: github\.ref == 'refs\/heads\/main' && \(github\.event_name == 'push' \|\| github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch'\)\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n    permissions:\n      contents: read\n      id-token: write\n      attestations: write$/mu,
    );
    expect(workflow).toContain(
      "uses: aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25 # v0.36.0",
    );
    expect(workflow).toContain("image-ref: connectwise-legacy-rollback-ci");
    expect(workflow).toContain("scanners: vuln");
    expect(workflow).toContain("vuln-type: os,library");
    expect(workflow).toContain("severity: HIGH,CRITICAL");
    expect(workflow).toContain("ignore-unfixed: true");
    expect(workflow).toContain('exit-code: "1"');
    expect(workflow).toContain("format: cyclonedx");
    expect(workflow).toContain(
      "output: connectwise-legacy-rollback-image.cdx.json",
    );
    expect(workflow).toContain(
      "sbom_sha256=$(sha256sum \"$sbom\" | cut -d ' ' -f 1)",
    );
    expect(workflow).toContain(
      "docker save connectwise-legacy-rollback-ci | gzip -n -9",
    );
    expect(workflow).toContain(
      "image_id=$(docker image inspect --format '{{.Id}}' connectwise-legacy-rollback-ci)",
    );
    expect(workflow).toContain(
      "archive_sha256=$(sha256sum \"$archive\" | cut -d ' ' -f 1)",
    );
    expect(workflow).toContain(
      'printf \'%s  %s\\n\' "$archive_sha256" "$archive" > "$checksum"',
    );
    for (const manifestBinding of [
      '"schemaVersion":2',
      '"releaseCommit":"%s"',
      '"workflowRunId":"%s"',
      '"imageRepository":"connectwise-legacy-rollback-ci"',
      '"imageId":"%s"',
      '"archive":"%s"',
      '"archiveSha256":"%s"',
      '"sbom":"%s"',
      '"sbomSha256":"%s"',
      '"$GITHUB_SHA" "$GITHUB_RUN_ID" "$image_id" "$archive" "$archive_sha256" "$sbom" "$sbom_sha256"',
    ]) {
      expect(workflow).toContain(manifestBinding);
    }
    expect(workflow).toContain(
      "python deploy/http-gateway/tests/verify_rollback_artifact.py",
    );
    expect(workflow).toContain('. "$GITHUB_SHA" "$GITHUB_RUN_ID"');
    expect(workflow).toContain(
      "docker image rm connectwise-legacy-rollback-ci",
    );
    expect(workflow).toContain(
      "gzip -dc connectwise-legacy-rollback-image.tar.gz | docker load",
    );
    expect(workflow).toContain(
      'test "$(docker image inspect --format \'{{.Id}}\' connectwise-legacy-rollback-ci)" = "$image_id"',
    );
    expect(attestJob).toContain(
      "uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1",
    );
    expect(attestJob).toContain(
      "name: legacy-rollback-image-${{ github.sha }}",
    );
    expect(attestStep).toContain(
      "uses: actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6 # v4.2.2",
    );
    const subjectBlock = `          subject-path: |\n${artifactFiles
      .map((file) => `            ${file}`)
      .join("\n")}\n`;
    expect(attestStep.endsWith(subjectBlock)).toBe(true);
    expect(attestStep.match(/subject-path: \|/gu)).toHaveLength(1);
    expect(retainStep).toContain(
      "uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1",
    );
    expect(retainStep).toContain(
      "if: github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'schedule' || github.event_name == 'workflow_dispatch')",
    );
    const retainedPathBlock = `          path: |\n${artifactFiles
      .map((file) => `            ${file}`)
      .join("\n")}\n          if-no-files-found: error`;
    expect(retainStep).toContain(retainedPathBlock);
    expect(retainStep.match(/path: \|/gu)).toHaveLength(1);
    expect(retainStep).toContain("retention-days: 90");
    expect(dockerfile).toMatch(
      /^FROM python:3\.12-slim@sha256:[0-9a-f]{64}$/mu,
    );
    expect(compose).toContain(
      "image: ${MCP_GATEWAY_IMAGE:-connectwise-legacy-rollback-local}",
    );
  });
});

describe("staging deployment configuration", () => {
  it("exercises the verified staging artifact without deploying it", async () => {
    const workflow = await readFile(
      new URL("../.github/workflows/v2-ci.yml", import.meta.url),
      "utf8",
    );
    const checkOffset = workflow.indexOf("      - run: npm run check");
    const stagingDryRunOffset = workflow.indexOf(
      "      - name: Exercise verified staging deployment path",
    );
    const productionDryRunOffset = workflow.indexOf(
      "      - name: Exercise verified production dry-run path",
    );
    const nextStepOffset = workflow.indexOf(
      "\n      - ",
      stagingDryRunOffset + 1,
    );
    const stagingDryRunStep = workflow.slice(
      stagingDryRunOffset,
      nextStepOffset === -1 ? undefined : nextStepOffset,
    );
    const productionDryRunStep = workflow.slice(productionDryRunOffset);

    expect(checkOffset).toBeGreaterThan(-1);
    expect(stagingDryRunOffset).toBeGreaterThan(checkOffset);
    expect(productionDryRunOffset).toBeGreaterThan(stagingDryRunOffset);
    expect(stagingDryRunStep).toContain(
      "STAGING_RELEASE_SHA: ${{ github.sha }}",
    );
    expect(stagingDryRunStep).toContain(
      "run: node scripts/staging-bundle-integrity.mjs dry-run",
    );
    expect(stagingDryRunStep).not.toContain(
      "staging-bundle-integrity.mjs deploy",
    );
    expect(productionDryRunStep).toContain(
      "if: github.event_name != 'pull_request'",
    );
    expect(productionDryRunStep).toContain(
      "PRODUCTION_RELEASE_SHA: ${{ github.sha }}",
    );
    expect(productionDryRunStep).not.toContain("STAGING_RELEASE_SHA");
    expect(productionDryRunStep).toContain(
      "git remote set-url origin https://github.com/luckyludev/ConnectwiseMCP.git",
    );
    expect(productionDryRunStep).toContain("npm run dry-run:production");
    expect(productionDryRunStep).not.toContain(
      "staging-bundle-integrity.mjs deploy",
    );
  });

  it("preserves remote variables and isolates staging OAuth storage", async () => {
    const [config, packageJson, productionEnvironment, stagingHowto] =
      await Promise.all([
        readWranglerConfig(),
        readJson("../package.json"),
        readFile(new URL("../config/empty.env", import.meta.url)),
        readFile(
          new URL(
            "../docs/cloudflare-workers-staging-howto.md",
            import.meta.url,
          ),
          "utf8",
        ),
      ]);
    const staging = config.env?.staging;
    const stagingOAuthBindings = (staging?.kv_namespaces ?? []).filter(
      ({ binding }) => binding === "OAUTH_KV",
    );
    const productionKvIds = (config.kv_namespaces ?? []).flatMap(
      ({ id, preview_id: previewId }) => [id, previewId].filter(Boolean),
    );

    expect(config.name).toBe("connectwise-mcp-v2");
    expect(staging).not.toHaveProperty("name");
    expect(staging?.workers_dev).toBe(true);
    for (const deploymentTarget of [config, staging]) {
      expect(deploymentTarget).not.toHaveProperty("route");
      expect(deploymentTarget).not.toHaveProperty("routes");
    }
    expect(config).not.toHaveProperty("keep_vars");
    for (const environment of Object.values(config.env ?? {})) {
      expect(environment).not.toHaveProperty("keep_vars");
    }
    expect(staging).not.toHaveProperty("vars");
    expect(packageJson.scripts?.["build:staging"]).toBe(
      "wrangler deploy --env staging --keep-vars --strict --dry-run --outdir dist && node scripts/staging-bundle-integrity.mjs create",
    );
    expect(packageJson.scripts?.["prepare:staging"]).toBe(
      "node scripts/verify-staging-release.mjs && npm ci && npm run check && node scripts/verify-staging-release.mjs",
    );
    expect(packageJson.scripts?.["deploy:staging"]).toBeUndefined();
    expect(stagingHowto).toContain(
      "STAGING_BUNDLE_SHA256=<approved-bundle-sha256>",
    );
    expect(stagingHowto).toContain(
      "STAGING_CONFIG_SHA256=<approved-configuration-sha256>",
    );
    expect(stagingHowto).toContain(
      "node scripts/staging-bundle-integrity.mjs deploy",
    );
    expect(stagingHowto).not.toContain("npm run deploy:staging");
    expect(packageJson.scripts?.["prepare:staging"]).toContain("npm ci");
    expect(packageJson.scripts?.["prepare:staging"]).toContain("npm run check");
    expect(productionEnvironment).toHaveLength(0);
    expect(packageJson.scripts?.["build:production"]).toBe(
      'wrangler deploy --env="" --env-file config/empty.env --keep-vars --strict --dry-run --outdir dist && node scripts/staging-bundle-integrity.mjs create production',
    );
    expect(packageJson.scripts?.["dry-run:production"]).toBe(
      "node scripts/verify-staging-release.mjs production && npm run build:production && node scripts/verify-staging-release.mjs production && node scripts/staging-bundle-integrity.mjs dry-run production",
    );
    expect(packageJson.scripts?.["deploy:production"]).toBeUndefined();
    expect(packageJson.scripts?.["build:production"]).not.toContain(
      "--env staging",
    );
    expect(packageJson.scripts?.check).not.toContain("deploy:production");

    expect(stagingOAuthBindings).toHaveLength(1);
    const [stagingKv] = stagingOAuthBindings;
    expect(stagingKv.id).toMatch(/^[0-9a-f]{32}$/u);
    expect(stagingKv.preview_id).toMatch(/^[0-9a-f]{32}$/u);
    expect(stagingKv.preview_id).not.toBe(stagingKv.id);
    expect(productionKvIds).not.toContain(stagingKv.id);
    expect(productionKvIds).not.toContain(stagingKv.preview_id);
  });

  it("requires an executable, evidence-backed cutover rollback plan", async () => {
    const [runbook, checklist, stagingHowto] = await Promise.all([
      readFile(
        new URL("../docs/cutover-rollback-runbook.md", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../docs/v2-staging-acceptance-checklist.md", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../docs/cloudflare-workers-staging-howto.md", import.meta.url),
        "utf8",
      ),
    ]);

    expect(checklist.match(/\(cutover-rollback-runbook\.md\)/gu)).toHaveLength(
      2,
    );
    expect(stagingHowto).toContain("(cutover-rollback-runbook.md)");
    expect(checklist).toContain(
      "staging release manifest binds both the generated regular, non-symlink, single-link `dist/index.js` bytes and the regular, non-symlink, single-link `wrangler.jsonc` bytes and SHA-256 digests",
    );
    expect(checklist).toContain(
      "passes only private read-only copies of those verified bytes to Wrangler while preserving configuration-relative path resolution",
    );
    for (const requiredSection of [
      "## 1. Required change record",
      "## 2. Measurable rollback triggers",
      "## 3. Preflight gate",
      "## 4. Controlled cutover",
      "## 5. Rollback decision and cutback",
      "## 6. Post-cutback acceptance and abort criteria",
      "## 7. Forward recovery and legacy retirement gate",
      "## 8. Rehearsal evidence",
    ]) {
      expect(runbook).toContain(requiredSection);
    }
    for (const requiredControl of [
      "rollback decision authority",
      "rollback recovery-time objective (RTO)",
      "exact ordered cutback sequence",
      "cutover and recovery cohort definitions",
      "cohort observation intervals",
      "legacy health thresholds",
      "stabilization interval",
      "zero tolerance",
      "If any preflight item fails, abort cutover",
      "approved maximum decision time expires without a decision",
      "Do not delete V2 resources or secrets; preserve evidence",
      "If the RTO or maximum rollback duration is exceeded",
      "Do not alternate targets repeatedly",
      "new focused commit, review, CI run, and staging acceptance cycle",
      "approved production monitoring period",
      "A failed or late rehearsal blocks cutover",
      "non-production rehearsal",
      "legacy-rollback-image-<release-commit>",
      "set -euo pipefail",
      'gh attestation verify "$artifact_file"',
      "--signer-workflow luckyludev/ConnectwiseMCP/.github/workflows/legacy-oauth-ci.yml",
      "--source-digest <FULL_RELEASE_COMMIT>",
      "--source-ref refs/heads/main",
      "python3 <REVIEWED_REPOSITORY_CHECKOUT>/deploy/http-gateway/tests/verify_rollback_artifact.py",
      "docker compose up -d --no-build --pull never",
      "docker compose stop cloudflared || exit 1",
      "The image-ID comparison must pass before starting the tunnel or routing any client",
      "A pull-request merge commit, a failed run, an expired artifact, an unattested file, or a local rebuild is not rollback evidence",
    ]) {
      expect(runbook).toContain(requiredControl);
    }
    const failFastOffset = runbook.indexOf("set -euo pipefail");
    const provenanceOffset = runbook.indexOf(
      'gh attestation verify "$artifact_file"',
    );
    const localVerificationOffset = runbook.indexOf(
      "python3 <REVIEWED_REPOSITORY_CHECKOUT>/deploy/http-gateway/tests/verify_rollback_artifact.py",
    );
    const imageLoadOffset = runbook.indexOf(
      "gzip -dc connectwise-legacy-rollback-image.tar.gz | docker load",
    );
    expect(failFastOffset).toBeGreaterThan(-1);
    expect(provenanceOffset).toBeGreaterThan(failFastOffset);
    expect(localVerificationOffset).toBeGreaterThan(provenanceOffset);
    expect(imageLoadOffset).toBeGreaterThan(localVerificationOffset);
    expect(runbook).toContain(
      "for artifact_file in \\\n  connectwise-legacy-rollback-image.tar.gz \\\n  connectwise-legacy-rollback-image.sha256 \\\n  connectwise-legacy-rollback-image.json \\\n  connectwise-legacy-rollback-image.cdx.json\ndo",
    );
    const legacyHealthOffset = runbook.indexOf(
      "Confirm the legacy gateway and tunnel are access-restricted and healthy",
    );
    const recoveryRoutingOffset = runbook.indexOf(
      "Restore the captured legacy routing/client configuration only for the smallest approved recovery cohort",
    );
    expect(legacyHealthOffset).toBeGreaterThan(-1);
    expect(recoveryRoutingOffset).toBeGreaterThan(legacyHealthOffset);
    expect(runbook).toContain(
      "service, security, and ConnectWise owners explicitly approve retirement",
    );
    expect(runbook).toContain(
      "only under a separate reviewed change with verification that no client still depends on them",
    );
    expect(runbook).toContain(
      "does not authorize deployment, DNS, Cloudflare or Entra changes, secret access, ConnectWise access, or production cutover",
    );
  });
});
