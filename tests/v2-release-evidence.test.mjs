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
const deploymentLauncher = fileURLToPath(
  new URL("../scripts/deploy-verified-bundle.sh", import.meta.url),
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
  await copyFile(
    deploymentLauncher,
    join(cwd, "scripts", "deploy-verified-bundle.sh"),
  );
  await mkdir(join(cwd, "node_modules", "package"), { recursive: true });
  await mkdir(join(cwd, "node_modules", "optional-installed"), {
    recursive: true,
  });
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
          optionalDependencies: {
            "optional-absent": "1.0.0",
            "optional-installed": "1.0.0",
            "package-directory-link": "1.0.0",
          },
        },
        "node_modules/optional-absent": {
          version: "1.0.0",
          optional: true,
        },
        "node_modules/optional-installed": {
          version: "1.0.0",
          optional: true,
        },
        "node_modules/package-directory-link": {
          version: "1.0.0",
          optional: true,
        },
        "node_modules/package": { version: "1.0.0" },
      },
    })}\n`,
  );
  await writeFile(join(cwd, "node_modules", "package", "index.js"), "ok\n");
  await writeFile(
    join(cwd, "node_modules", "optional-installed", "index.js"),
    "optional\n",
  );
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
          {
            "bom-ref": "optional-installed@1.0.0",
            type: "library",
            name: "optional-installed",
            version: "1.0.0",
          },
          {
            "bom-ref": "package-directory-link@1.0.0",
            type: "library",
            name: "package-directory-link",
            version: "1.0.0",
          },
        ],
        dependencies: [
          {
            ref: "evidence-test@1.0.0",
            dependsOn: [
              "optional-installed@1.0.0",
              "package-directory-link@1.0.0",
              "package@1.0.0",
            ],
          },
          { ref: "package@1.0.0", dependsOn: [] },
          { ref: "optional-installed@1.0.0", dependsOn: [] },
          { ref: "package-directory-link@1.0.0", dependsOn: [] },
        ],
      },
      null,
      2,
    )}\n`,
  );
  return {
    candidateManifestPath: join(cwd, "dist", manifestName),
    cwd,
    evidence,
    inventoryName,
    manifestName,
    release,
    target,
  };
}

async function makeDistEvidencePath(fixture, throughParentAlias = false) {
  await Promise.all([
    copyFile(
      join(fixture.evidence, "wrangler.jsonc"),
      join(fixture.cwd, "dist", "wrangler.jsonc"),
    ),
    copyFile(
      join(fixture.evidence, "package-lock.json"),
      join(fixture.cwd, "dist", "package-lock.json"),
    ),
    copyFile(
      join(fixture.evidence, `connectwise-v2-${fixture.target}.cdx.json`),
      join(fixture.cwd, "dist", `connectwise-v2-${fixture.target}.cdx.json`),
    ),
  ]);
  if (!throughParentAlias) return join(fixture.cwd, "dist");

  const alias = join(fixture.cwd, "checkout-alias");
  await symlink(fixture.cwd, alias);
  return join(alias, "dist");
}

function verify({ cwd, evidence, release, target, withCandidate = false }) {
  return spawnSync(
    process.execPath,
    [
      verifierScript,
      evidence,
      target,
      release,
      ...(withCandidate
        ? [
            "--candidate-manifest",
            join("dist", `${target}-bundle-manifest.json`),
          ]
        : []),
    ],
    { cwd, encoding: "utf8" },
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

async function bindLock(fixture, mutate) {
  const lockPath = join(fixture.evidence, "package-lock.json");
  const manifestPath = join(fixture.evidence, fixture.manifestName);
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  mutate(lock);
  const bytes = Buffer.from(`${JSON.stringify(lock)}\n`);
  await writeFile(lockPath, bytes);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.lockSize = bytes.length;
  manifest.lockSha256 = createHash("sha256").update(bytes).digest("hex");
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

  it.each(["staging", "production"])(
    "matches a prepared %s candidate to the canonical release manifest",
    async (target) => {
      const fixture = await makeEvidence(target);
      const result = verify({ ...fixture, withCandidate: true });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(
        `Verified ${target} V2 release evidence and matching candidate manifest for ${fixture.release}.\n`,
      );
    },
  );

  it("rejects using the canonical evidence manifest as the candidate path", async () => {
    const fixture = await makeEvidence();
    const result = spawnSync(
      process.execPath,
      [
        verifierScript,
        fixture.evidence,
        fixture.target,
        fixture.release,
        "--candidate-manifest",
        join(fixture.evidence, fixture.manifestName),
      ],
      { cwd: fixture.cwd, encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `candidate manifest path must be ${join("dist", fixture.manifestName)}`,
    );
  });

  it.each([
    ["direct", false],
    ["parent-component alias", true],
  ])(
    "rejects a %s from the evidence directory to candidate dist",
    async (_name, throughParentAlias) => {
      const fixture = await makeEvidence();
      const evidence = await makeDistEvidencePath(fixture, throughParentAlias);

      const result = verify({
        ...fixture,
        evidence,
        withCandidate: true,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "candidate dist directory must be separate from release evidence",
      );
    },
  );

  it.each(["staging", "production"])(
    "rejects %s candidate assets that do not match the candidate manifest",
    async (target) => {
      const fixture = await makeEvidence(target);
      await writeFile(
        join(fixture.cwd, "dist", "index.js"),
        "unbound local build\n",
      );

      const result = verify({ ...fixture, withCandidate: true });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        `${join("dist", "index.js")} does not match the candidate manifest binding`,
      );
    },
  );

  it.each([
    ["sha256", "bundle"],
    ["configSha256", "configuration"],
    ["lockSha256", "lockfile"],
  ])(
    "rejects a candidate with a different %s binding",
    async (field, _description) => {
      const fixture = await makeEvidence();
      const candidate = JSON.parse(
        await readFile(fixture.candidateManifestPath, "utf8"),
      );
      candidate[field] = "f".repeat(64);
      await writeFile(
        fixture.candidateManifestPath,
        `${JSON.stringify(candidate, null, 2)}\n`,
      );

      const result = verify({ ...fixture, withCandidate: true });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        `candidate manifest does not match release evidence field ${field}`,
      );
    },
  );

  it.each([
    ["target", "production"],
    ["releaseCommit", "f".repeat(40)],
  ])("rejects a candidate with the wrong %s", async (field, value) => {
    const fixture = await makeEvidence();
    const candidate = JSON.parse(
      await readFile(fixture.candidateManifestPath, "utf8"),
    );
    candidate[field] = value;
    await writeFile(
      fixture.candidateManifestPath,
      `${JSON.stringify(candidate, null, 2)}\n`,
    );

    const result = verify({ ...fixture, withCandidate: true });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "candidate manifest has an invalid canonical schema or release binding",
    );
  });

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

  it("rejects a non-canonical package-lock path before inventory matching", async () => {
    const fixture = await makeEvidence();
    await bindLock(fixture, (lock) => {
      lock.packages["node_modules/../node_modules/optional-installed"] = {
        version: "1.0.0",
        optional: true,
      };
    });
    expect(verify(fixture).stderr).toContain(
      "package-lock.json contains an invalid package record",
    );
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

  it("rejects an SBOM missing an installed optional lock package", async () => {
    const fixture = await makeEvidence();
    await mutateSbom(fixture, (sbom) => {
      sbom.components = sbom.components.filter(
        (component) => component.name !== "optional-installed",
      );
      sbom.dependencies = sbom.dependencies
        .filter((dependency) => dependency.ref !== "optional-installed@1.0.0")
        .map((dependency) => ({
          ...dependency,
          dependsOn: dependency.dependsOn.filter(
            (reference) => reference !== "optional-installed@1.0.0",
          ),
        }));
    });
    expect(verify(fixture).stderr).toContain(
      "omits an installed or non-optional package-lock.json package",
    );
  });

  it("rejects an SBOM missing a symlink-installed optional lock package", async () => {
    const fixture = await makeEvidence();
    await mutateSbom(fixture, (sbom) => {
      sbom.components = sbom.components.filter(
        (component) => component.name !== "package-directory-link",
      );
      sbom.dependencies = sbom.dependencies
        .filter(
          (dependency) => dependency.ref !== "package-directory-link@1.0.0",
        )
        .map((dependency) => ({
          ...dependency,
          dependsOn: dependency.dependsOn.filter(
            (reference) => reference !== "package-directory-link@1.0.0",
          ),
        }));
    });
    expect(verify(fixture).stderr).toContain(
      "omits an installed or non-optional package-lock.json package",
    );
  });

  it("allows an absent platform-optional lock package to be omitted", async () => {
    const fixture = await makeEvidence();
    const lock = JSON.parse(
      await readFile(join(fixture.evidence, "package-lock.json"), "utf8"),
    );
    const sbom = JSON.parse(
      await readFile(
        join(fixture.evidence, `connectwise-v2-${fixture.target}.cdx.json`),
        "utf8",
      ),
    );

    expect(lock.packages["node_modules/optional-absent"].optional).toBe(true);
    expect(
      sbom.components.some((component) => component.name === "optional-absent"),
    ).toBe(false);
    expect(verify(fixture).status).toBe(0);
  });

  it("rejects an SBOM missing a non-optional lock package", async () => {
    const fixture = await makeEvidence();
    await mutateSbom(fixture, (sbom) => {
      sbom.components = [];
    });
    expect(verify(fixture).stderr).toContain(
      "omits an installed or non-optional package-lock.json package",
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
