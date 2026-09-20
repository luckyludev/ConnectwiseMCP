import { readFile } from "node:fs/promises";

import ts from "typescript";
import { describe, expect, it } from "vitest";

async function readJson(relativePath) {
  const path = new URL(relativePath, import.meta.url);
  return JSON.parse(await readFile(path, "utf8"));
}

async function readWranglerConfig() {
  const path = new URL("../wrangler.jsonc", import.meta.url);
  const source = await readFile(path, "utf8");
  const parsed = ts.parseConfigFileTextToJson(path.pathname, source);

  expect(parsed.error).toBeUndefined();
  return parsed.config;
}

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

    expect(config).not.toHaveProperty("keep_vars");
    for (const environment of Object.values(config.env ?? {})) {
      expect(environment).not.toHaveProperty("keep_vars");
    }
    expect(staging).not.toHaveProperty("vars");
    expect(packageJson.scripts?.["build:staging"]).toBe(
      "wrangler deploy --env staging --keep-vars --dry-run --outdir dist",
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
