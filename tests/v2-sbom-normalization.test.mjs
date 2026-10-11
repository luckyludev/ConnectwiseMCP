import { spawnSync } from "node:child_process";
import {
  link,
  mkdtemp,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const script = fileURLToPath(
  new URL("../scripts/normalize-v2-sbom.mjs", import.meta.url),
);
const temporaryDirectories = [];

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "cw-v2-sbom-"));
  temporaryDirectories.push(directory);
  const sbomPath = join(directory, "sbom.json");
  const lockPath = join(directory, "package-lock.json");
  await writeFile(
    sbomPath,
    `${JSON.stringify({
      $schema: "http://cyclonedx.org/schema/bom-1.5.schema.json",
      bomFormat: "CycloneDX",
      specVersion: "1.5",
      serialNumber: "urn:uuid:***",
      version: 1,
      metadata: {
        component: {
          "bom-ref": "connectwise-mcp-v2@2.0.0-alpha.1",
          type: "library",
          name: "checkout-directory",
          version: "2.0.0-alpha.1",
        },
      },
      components: [],
      dependencies: [],
    })}\n`,
  );
  await writeFile(
    lockPath,
    `${JSON.stringify({
      name: "connectwise-mcp-v2",
      version: "2.0.0-alpha.1",
      lockfileVersion: 3,
      packages: {},
    })}\n`,
  );
  return { directory, lockPath, sbomPath };
}

function normalize(sbomPath, lockPath) {
  return spawnSync(process.execPath, [script, sbomPath, lockPath], {
    encoding: "utf8",
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("V2 SBOM normalization", () => {
  it("replaces npm's redacted serial and binds the root package name", async () => {
    const { lockPath, sbomPath } = await fixture();

    const result = normalize(sbomPath, lockPath);
    const bytes = await readFile(sbomPath, "utf8");
    const sbom = JSON.parse(bytes);

    expect(result.status, result.stderr).toBe(0);
    expect(sbom.metadata.component.name).toBe("connectwise-mcp-v2");
    expect(sbom.serialNumber).toMatch(
      /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(bytes).toBe(`${JSON.stringify(sbom, null, 2)}\n`);
  });

  it("rejects a symlinked SBOM", async () => {
    const { directory, lockPath, sbomPath } = await fixture();
    const linkPath = join(directory, "sbom-link.json");
    await symlink(sbomPath, linkPath);

    const result = normalize(linkPath, lockPath);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("non-symlink");
  });

  it("rejects a hard-linked SBOM", async () => {
    const { directory, lockPath, sbomPath } = await fixture();
    await link(sbomPath, join(directory, "second-link.json"));

    const result = normalize(sbomPath, lockPath);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("single-link");
  });

  it("rejects a symlinked package lock", async () => {
    const { directory, lockPath, sbomPath } = await fixture();
    const linkPath = join(directory, "lock-link.json");
    await symlink(lockPath, linkPath);

    const result = normalize(sbomPath, linkPath);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("non-symlink");
  });

  it("rejects malformed CycloneDX JSON", async () => {
    const { lockPath, sbomPath } = await fixture();
    await writeFile(sbomPath, "not json\n");

    const result = normalize(sbomPath, lockPath);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("is not valid JSON");
  });

  it("rejects an oversized CycloneDX file before parsing", async () => {
    const { lockPath, sbomPath } = await fixture();
    await truncate(sbomPath, 64 * 1024 * 1024 + 1);

    const result = normalize(sbomPath, lockPath);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("bounded regular");
  });
});
