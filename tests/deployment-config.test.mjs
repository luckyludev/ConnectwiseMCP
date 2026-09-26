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
    for (const workflow of [v2Workflow, legacyWorkflow]) {
      expect(workflow.match(/- "\.github\/dependabot\.yml"/gu)).toHaveLength(2);
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
    expect(legacyWorkflow.match(/- "deploy\/\*\*"/gu)).toHaveLength(2);
    expect(v2Workflow.match(/- "deploy\/\*\*"/gu)).toHaveLength(2);
    expect(
      v2Workflow.match(/- "\.github\/workflows\/legacy-oauth-ci\.yml"/gu),
    ).toHaveLength(2);
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
  it("fails CI when the built rollback image has fixable severe vulnerabilities", async () => {
    const [workflow, dockerfile] = await Promise.all([
      readFile(
        new URL("../.github/workflows/legacy-oauth-ci.yml", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../deploy/http-gateway/Dockerfile", import.meta.url),
        "utf8",
      ),
    ]);
    const buildOffset = workflow.indexOf("- name: Build rollback image");
    const scanOffset = workflow.indexOf(
      "- name: Scan rollback image for fixable severe vulnerabilities",
    );
    const smokeOffset = workflow.indexOf(
      "- name: Smoke-test rollback image startup and auth boundary",
    );

    expect(buildOffset).toBeGreaterThan(-1);
    expect(scanOffset).toBeGreaterThan(buildOffset);
    expect(smokeOffset).toBeGreaterThan(scanOffset);
    expect(workflow).toContain(
      "uses: aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25 # v0.36.0",
    );
    expect(workflow).toContain("image-ref: connectwise-legacy-rollback-ci");
    expect(workflow).toContain("scanners: vuln");
    expect(workflow).toContain("vuln-type: os,library");
    expect(workflow).toContain("severity: HIGH,CRITICAL");
    expect(workflow).toContain("ignore-unfixed: true");
    expect(workflow).toContain('exit-code: "1"');
    expect(dockerfile).toMatch(
      /^FROM python:3\.12-slim@sha256:[0-9a-f]{64}$/mu,
    );
  });
});

describe("staging deployment configuration", () => {
  it("preserves remote variables and isolates staging OAuth storage", async () => {
    const [config, packageJson] = await Promise.all([
      readWranglerConfig(),
      readJson("../package.json"),
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
      "wrangler deploy --env staging --keep-vars --strict --dry-run --outdir dist",
    );
    expect(packageJson.scripts?.["deploy:staging"]).toBe(
      "node scripts/verify-staging-release.mjs && npm ci && npm run check && node scripts/verify-staging-release.mjs && wrangler deploy --env staging --keep-vars --strict",
    );

    expect(stagingOAuthBindings).toHaveLength(1);
    const [stagingKv] = stagingOAuthBindings;
    expect(stagingKv.id).toMatch(/^[0-9a-f]{32}$/u);
    expect(stagingKv.preview_id).toMatch(/^[0-9a-f]{32}$/u);
    expect(stagingKv.preview_id).not.toBe(stagingKv.id);
    expect(productionKvIds).not.toContain(stagingKv.id);
    expect(productionKvIds).not.toContain(stagingKv.preview_id);
  });
});
