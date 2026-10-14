import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const integrityScript = fileURLToPath(
  new URL("../scripts/staging-bundle-integrity.mjs", import.meta.url),
);
const verifierScript = fileURLToPath(
  new URL("../scripts/verify-v2-release-evidence.mjs", import.meta.url),
);
const temporaryDirectories = [];

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

async function makeEvidence(target = "staging") {
  const cwd = await mkdtemp(join(tmpdir(), "cw-v2-evidence-source-"));
  const evidence = await mkdtemp(join(tmpdir(), "cw-v2-evidence-"));
  temporaryDirectories.push(cwd, evidence);
  await mkdir(join(cwd, "dist"));
  await mkdir(join(cwd, "scripts"));
  await copyFile(
    integrityScript,
    join(cwd, "scripts", "staging-bundle-integrity.mjs"),
  );
  await mkdir(join(cwd, "node_modules", "package"), { recursive: true });
  await writeFile(join(cwd, "dist", "index.js"), "export default {};\n");
  await writeFile(join(cwd, "wrangler.jsonc"), '{"name":"evidence-test"}\n');
  await writeFile(
    join(cwd, "package-lock.json"),
    `${JSON.stringify({
      name: "evidence-test",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: {
        "": {
          name: "evidence-test",
          version: "1.0.0",
          dependencies: { package: "1.0.0" },
        },
        "node_modules/package": { version: "1.0.0" },
      },
    })}\n`,
  );
  await writeFile(join(cwd, "node_modules", "package", "index.js"), "ok\n");
  await symlink("package/index.js", join(cwd, "node_modules", "package-link"));
  await symlink("package", join(cwd, "node_modules", "package-directory-link"));
  await symlink("package", join(cwd, "node_modules", "package-alias"));
  await symlink(
    "package-alias/../package-alias/index.js",
    join(cwd, "node_modules", "link-through-directory-link"),
  );
  git(cwd, "init", "--quiet");
  git(cwd, "config", "user.name", "Evidence Test");
  git(cwd, "config", "user.email", "evidence@example.invalid");
  git(cwd, "add", "wrangler.jsonc", "package-lock.json");
  git(cwd, "commit", "--quiet", "-m", "release");
  const release = git(cwd, "rev-parse", "HEAD");
  const create = spawnSync(
    process.execPath,
    [integrityScript, "create", ...(target === "production" ? [target] : [])],
    { cwd, encoding: "utf8" },
  );
  expect(create.status, create.stderr).toBe(0);

  const manifestName = `${target}-bundle-manifest.json`;
  const inventoryName = `${target}-runtime-inventory.json`;
  await Promise.all([
    copyFile(join(cwd, "dist", "index.js"), join(evidence, "index.js")),
    copyFile(join(cwd, "wrangler.jsonc"), join(evidence, "wrangler.jsonc")),
    copyFile(
      join(cwd, "package-lock.json"),
      join(evidence, "package-lock.json"),
    ),
    copyFile(join(cwd, "dist", manifestName), join(evidence, manifestName)),
    copyFile(join(cwd, "dist", inventoryName), join(evidence, inventoryName)),
  ]);
  await writeFile(
    join(evidence, `connectwise-v2-${target}.cdx.json`),
    `${JSON.stringify(
      {
        $schema: "http://cyclonedx.org/schema/bom-1.5.schema.json",
        bomFormat: "CycloneDX",
        specVersion: "1.5",
        serialNumber: "urn:uuid:12345678-1234-4234-8234-123456789abc",
        version: 1,
        metadata: {
          component: {
            "bom-ref": "evidence-test@1.0.0",
            type: "library",
            name: "evidence-test",
            version: "1.0.0",
            purl: "pkg:npm/evidence-test@1.0.0",
          },
        },
        components: [
          {
            "bom-ref": "package@1.0.0",
            type: "library",
            name: "package",
            version: "1.0.0",
          },
        ],
        dependencies: [
          { ref: "evidence-test@1.0.0", dependsOn: ["package@1.0.0"] },
          { ref: "package@1.0.0", dependsOn: [] },
        ],
      },
      null,
      2,
    )}\n`,
  );
  return { evidence, inventoryName, manifestName, release, target };
}

function verify({ evidence, release, target }) {
  return spawnSync(
    process.execPath,
    [verifierScript, evidence, target, release],
    { encoding: "utf8" },
  );
}

async function bindInventory(fixture, mutate) {
  const inventoryPath = join(fixture.evidence, fixture.inventoryName);
  const manifestPath = join(fixture.evidence, fixture.manifestName);
  const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
  mutate(inventory);
  const bytes = Buffer.from(`${JSON.stringify(inventory, null, 2)}\n`);
  await writeFile(inventoryPath, bytes);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.runtimeInventorySize = bytes.length;
  manifest.runtimeInventorySha256 = createHash("sha256")
    .update(bytes)
    .digest("hex");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function mutateSbom(fixture, mutate) {
  const path = join(
    fixture.evidence,
    `connectwise-v2-${fixture.target}.cdx.json`,
  );
  const sbom = JSON.parse(await readFile(path, "utf8"));
  mutate(sbom);
  await writeFile(path, `${JSON.stringify(sbom, null, 2)}\n`);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("offline V2 release evidence verifier", () => {
  it.each(["staging", "production"])(
    "verifies valid %s evidence without a checkout runtime",
    async (target) => {
      const fixture = await makeEvidence(target);
      const result = verify(fixture);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(
        `Verified ${target} V2 release evidence for ${fixture.release}.\n`,
      );
    },
  );

  it("rejects tampered bound content", async () => {
    const fixture = await makeEvidence();
    await writeFile(join(fixture.evidence, "index.js"), "tampered\n");
    expect(verify(fixture).status).toBe(1);
  });

  it("rejects a missing expected file", async () => {
    const fixture = await makeEvidence();
    await unlink(join(fixture.evidence, "package-lock.json"));
    expect(verify(fixture).stderr).toContain("exact expected file set");
  });

  it("rejects an extra file", async () => {
    const fixture = await makeEvidence();
    await writeFile(join(fixture.evidence, "extra"), "no\n");
    expect(verify(fixture).stderr).toContain("exact expected file set");
  });

  it("rejects a symlinked evidence file", async () => {
    const fixture = await makeEvidence();
    const path = join(fixture.evidence, "index.js");
    const outside = await mkdtemp(join(tmpdir(), "cw-v2-symlink-"));
    temporaryDirectories.push(outside);
    await writeFile(join(outside, "index.js"), "replacement\n");
    await unlink(path);
    await symlink(join(outside, "index.js"), path);
    expect(verify(fixture).stderr).toContain("non-symlink");
  });

  it("rejects a hard-linked evidence file", async () => {
    const fixture = await makeEvidence();
    const outside = await mkdtemp(join(tmpdir(), "cw-v2-hardlink-"));
    temporaryDirectories.push(outside);
    await link(join(fixture.evidence, "index.js"), join(outside, "index.js"));
    expect(verify(fixture).stderr).toContain("single-link");
  });

  it("rejects a malformed but manifest-bound inventory", async () => {
    const fixture = await makeEvidence();
    await bindInventory(fixture, (inventory) => {
      const fileRecord = inventory.records.find(
        (record) => record[0] === "file",
      );
      fileRecord[3] = -1;
    });
    expect(verify(fixture).stderr).toContain("malformed file record");
  });

  it("rejects an inventory symlink that escapes the runtime", async () => {
    const fixture = await makeEvidence();
    await bindInventory(fixture, (inventory) => {
      inventory.records.find((record) => record[0] === "link")[2] =
        "../outside";
    });
    expect(verify(fixture).stderr).toContain("escapes the runtime");
  });

  it("rejects an inventory symlink with a missing target", async () => {
    const fixture = await makeEvidence();
    await bindInventory(fixture, (inventory) => {
      inventory.records.find((record) => record[0] === "link")[2] = "missing";
    });
    expect(verify(fixture).stderr).toContain("missing target");
  });

  it("rejects an inventory symlink path that traverses a file", async () => {
    const fixture = await makeEvidence();
    await bindInventory(fixture, (inventory) => {
      inventory.records.find((record) => record[0] === "link")[2] =
        "package/index.js/.";
    });
    expect(verify(fixture).stderr).toContain("traverses a non-directory");
  });

  it("rejects an inventory symlink cycle", async () => {
    const fixture = await makeEvidence();
    await bindInventory(fixture, (inventory) => {
      const links = inventory.records.filter((record) => record[0] === "link");
      links[0][2] = links[1][1];
      links[1][2] = links[0][1];
    });
    expect(verify(fixture).stderr).toContain("symlink cycle");
  });

  it("rejects an SBOM component unrelated to package-lock.json", async () => {
    const fixture = await makeEvidence();
    await mutateSbom(fixture, (sbom) => {
      sbom.components[0].name = "unrelated";
    });
    expect(verify(fixture).stderr).toContain(
      "duplicate or unrelated component",
    );
  });

  it("rejects SBOM root metadata with the wrong package name", async () => {
    const fixture = await makeEvidence();
    await mutateSbom(fixture, (sbom) => {
      sbom.metadata.component.name = "unrelated";
    });
    expect(verify(fixture).stderr).toContain(
      "root metadata does not match package-lock.json",
    );
  });

  it("rejects an SBOM missing a non-optional lock package", async () => {
    const fixture = await makeEvidence();
    await mutateSbom(fixture, (sbom) => {
      sbom.components = [];
    });
    expect(verify(fixture).stderr).toContain(
      "omits a non-optional package-lock.json package",
    );
  });

  it("rejects dangling SBOM dependency references", async () => {
    const fixture = await makeEvidence();
    await mutateSbom(fixture, (sbom) => {
      sbom.dependencies[0].dependsOn.push("missing@1.0.0");
    });
    expect(verify(fixture).stderr).toContain("dangling dependency references");
  });

  it("rejects an SBOM dependency graph that differs from the package lock", async () => {
    const fixture = await makeEvidence();
    await mutateSbom(fixture, (sbom) => {
      sbom.dependencies[0].dependsOn = [];
    });
    expect(verify(fixture).stderr).toContain(
      "dependency graph does not match package-lock.json",
    );
  });

  it("rejects an SBOM missing dependency records", async () => {
    const fixture = await makeEvidence();
    await mutateSbom(fixture, (sbom) => {
      sbom.dependencies = [];
    });
    expect(verify(fixture).stderr).toContain(
      "omits dependency records for declared components",
    );
  });

  it("rejects an oversized inventory before parsing it", async () => {
    const fixture = await makeEvidence();
    await truncate(
      join(fixture.evidence, fixture.inventoryName),
      64 * 1024 * 1024 + 1,
    );
    expect(verify(fixture).stderr).toContain("bounded regular");
  });
});
