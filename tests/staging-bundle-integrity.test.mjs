import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const integrityPath = fileURLToPath(
  new URL("../scripts/staging-bundle-integrity.mjs", import.meta.url),
);
const projectNodeModules = fileURLToPath(
  new URL("../node_modules", import.meta.url),
);

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

async function createCheckout() {
  const cwd = await mkdtemp(join(tmpdir(), "cw-staging-bundle-"));
  await mkdir(join(cwd, "dist"));
  await writeFile(join(cwd, "release.txt"), "reviewed\n");
  await writeFile(join(cwd, "dist", "index.js"), "export default {};\n");
  await writeFile(
    join(cwd, "wrangler.jsonc"),
    JSON.stringify({
      name: "connectwise-staging-bundle-test",
      compatibility_date: "2026-09-01",
      env: { staging: { name: "connectwise-staging-bundle-test-staging" } },
    }),
  );
  git(cwd, ["init", "--quiet"]);
  git(cwd, ["config", "user.name", "Staging Bundle Test"]);
  git(cwd, ["config", "user.email", "staging-bundle@example.invalid"]);
  git(cwd, ["add", "release.txt", "wrangler.jsonc"]);
  git(cwd, ["commit", "--quiet", "-m", "reviewed release"]);
  return { cwd, head: git(cwd, ["rev-parse", "HEAD"]) };
}

function run(
  cwd,
  action,
  releaseSha,
  environmentOverrides = {},
  target = "staging",
) {
  const env = { ...process.env };
  delete env.STAGING_RELEASE_SHA;
  delete env.PRODUCTION_RELEASE_SHA;
  delete env.STAGING_BUNDLE_SHA256;
  delete env.STAGING_CONFIG_SHA256;
  delete env.PRODUCTION_BUNDLE_SHA256;
  delete env.PRODUCTION_CONFIG_SHA256;
  Object.assign(env, environmentOverrides);
  const releaseVariable =
    target === "production" ? "PRODUCTION_RELEASE_SHA" : "STAGING_RELEASE_SHA";
  if (releaseSha !== undefined) env[releaseVariable] = releaseSha;
  const arguments_ = [integrityPath, action];
  if (target !== "staging") arguments_.push(target);
  return spawnSync(process.execPath, arguments_, {
    cwd,
    env,
    encoding: "utf8",
  });
}

async function stagingDeploymentDigests(cwd) {
  const manifest = JSON.parse(
    await readFile(join(cwd, "dist", "staging-bundle-manifest.json"), "utf8"),
  );
  return {
    STAGING_BUNDLE_SHA256: manifest.sha256,
    STAGING_CONFIG_SHA256: manifest.configSha256,
  };
}

async function withCheckout(callback) {
  const checkout = await createCheckout();
  try {
    await callback(checkout);
  } finally {
    await rm(checkout.cwd, { recursive: true, force: true });
  }
}

describe("staging bundle integrity", () => {
  it("binds the generated bundle to the checked-out release", async () => {
    await withCheckout(async ({ cwd, head }) => {
      const created = run(cwd, "create");
      const verified = run(cwd, "verify", head);

      expect(created.status, created.stderr).toBe(0);
      expect(created.stdout).toMatch(
        new RegExp(
          `^Recorded staging bundle [0-9a-f]{64} and configuration [0-9a-f]{64} for ${head}\\.\\n$`,
        ),
      );
      expect(verified.status, verified.stderr).toBe(0);
      expect(verified.stdout).toMatch(
        new RegExp(`^Verified staging bundle [0-9a-f]{64} for ${head}\\.\\n$`),
      );
    });
  });

  it("rejects a Wrangler configuration modified before manifest creation", async () => {
    await withCheckout(async ({ cwd }) => {
      await writeFile(join(cwd, "wrangler.jsonc"), '{"unreviewed":true}\n');

      const result = run(cwd, "create");

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "The staging Wrangler configuration does not match the release commit.",
      );
    });
  });

  it("rejects a self-consistent manifest for an uncommitted Wrangler configuration", async () => {
    await withCheckout(async ({ cwd, head }) => {
      expect(run(cwd, "create").status).toBe(0);
      const config = Buffer.from('{"unreviewed":true}\n');
      await writeFile(join(cwd, "wrangler.jsonc"), config);
      const manifestPath = join(cwd, "dist", "staging-bundle-manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.configSha256 = createHash("sha256").update(config).digest("hex");
      manifest.configSize = config.length;
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

      const result = run(cwd, "verify", head);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "The staging Wrangler configuration does not match the release commit.",
      );
    });
  });

  it("rejects a bundle modified after its manifest was created", async () => {
    await withCheckout(async ({ cwd, head }) => {
      expect(run(cwd, "create").status).toBe(0);
      await writeFile(join(cwd, "dist", "index.js"), "tampered\n");

      const result = run(cwd, "verify", head);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "The staging bundle does not match its release manifest.",
      );
    });
  });

  it("rejects a Wrangler configuration modified after its manifest was created", async () => {
    await withCheckout(async ({ cwd, head }) => {
      expect(run(cwd, "create").status).toBe(0);
      await writeFile(join(cwd, "wrangler.jsonc"), '{"tampered":true}\n');

      const result = run(cwd, "verify", head);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "The staging Wrangler configuration does not match its release manifest.",
      );
    });
  });

  it("rejects a symlinked Wrangler configuration", async () => {
    await withCheckout(async ({ cwd }) => {
      await writeFile(join(cwd, "replacement.jsonc"), "{}\n");
      await unlink(join(cwd, "wrangler.jsonc"));
      await symlink(
        join(cwd, "replacement.jsonc"),
        join(cwd, "wrangler.jsonc"),
      );

      const result = run(cwd, "create");

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "The staging Wrangler configuration must be a regular, non-symlink, single-link file.",
      );
    });
  });

  it("rejects a symlinked staging bundle", async () => {
    await withCheckout(async ({ cwd, head }) => {
      expect(run(cwd, "create").status).toBe(0);
      await writeFile(join(cwd, "replacement.js"), "replacement\n");
      await unlink(join(cwd, "dist", "index.js"));
      await symlink(join(cwd, "replacement.js"), join(cwd, "dist", "index.js"));

      const result = run(cwd, "verify", head);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "The staging bundle must be a regular, non-symlink, single-link file.",
      );
    });
  });

  it("rejects a symlinked staging bundle directory", async () => {
    await withCheckout(async ({ cwd }) => {
      await rename(join(cwd, "dist"), join(cwd, "outside-dist"));
      await symlink(join(cwd, "outside-dist"), join(cwd, "dist"));

      const result = run(cwd, "create");

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "The staging bundle directory must be a real directory.",
      );
    });
  });

  it("rejects a hard-linked staging bundle", async () => {
    await withCheckout(async ({ cwd }) => {
      await link(join(cwd, "dist", "index.js"), join(cwd, "outside.js"));

      const result = run(cwd, "create");

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "The staging bundle must be a regular, non-symlink, single-link file.",
      );
    });
  });

  it("rejects a symlinked manifest during creation", async () => {
    await withCheckout(async ({ cwd }) => {
      await writeFile(join(cwd, "outside.json"), "do not replace\n");
      await symlink(
        join(cwd, "outside.json"),
        join(cwd, "dist", "staging-bundle-manifest.json"),
      );

      const result = run(cwd, "create");

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "The staging bundle manifest must be a regular, non-symlink, single-link file.",
      );
    });
  });

  it("rejects a hard-linked manifest during creation", async () => {
    await withCheckout(async ({ cwd }) => {
      await writeFile(join(cwd, "outside.json"), "do not replace\n");
      await link(
        join(cwd, "outside.json"),
        join(cwd, "dist", "staging-bundle-manifest.json"),
      );

      const result = run(cwd, "create");

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "The staging bundle manifest must be a regular, non-symlink, single-link file.",
      );
    });
  });

  it("keeps the verified config beside the reviewed config", async () => {
    await withCheckout(async ({ cwd, head }) => {
      const bin = join(cwd, "node_modules", ".bin");
      const wrangler = join(bin, "wrangler");
      await mkdir(bin, { recursive: true });
      await writeFile(
        wrangler,
        `#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
const configPath = process.argv[6];
if (dirname(resolve(configPath)) !== process.cwd()) process.exit(2);
if (!readFileSync(configPath, "utf8").includes("connectwise-staging-bundle-test")) process.exit(3);
const environmentFlag = process.argv.indexOf("--env-file");
if (environmentFlag < 0 || !process.argv[environmentFlag + 1]) process.exit(4);
if (readFileSync(process.argv[environmentFlag + 1]).length !== 0) process.exit(5);
const tagFlag = process.argv.indexOf("--tag");
if (tagFlag < 0 || process.argv[tagFlag + 1] !== ${JSON.stringify(head)}) process.exit(6);
const messageFlag = process.argv.indexOf("--message");
if (messageFlag < 0 || process.argv[messageFlag + 1] !== ${JSON.stringify(`ConnectwiseMCP staging release ${head}`)}) process.exit(7);
`,
      );
      await chmod(wrangler, 0o755);
      expect(run(cwd, "create").status).toBe(0);

      const result = run(cwd, "dry-run", head);

      expect(result.status, result.stderr).toBe(0);
    });
  });

  it("passes the private verified copy to the real Wrangler CLI", async () => {
    await withCheckout(async ({ cwd, head }) => {
      await writeFile(
        join(cwd, "wrangler.jsonc"),
        JSON.stringify({
          name: "connectwise-staging-bundle-test",
          compatibility_date: "2026-09-01",
          env: { staging: { name: "connectwise-staging-bundle-test-staging" } },
        }),
      );
      await symlink(projectNodeModules, join(cwd, "node_modules"), "dir");
      expect(run(cwd, "create").status).toBe(0);

      const result = run(cwd, "dry-run", head);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("--dry-run: exiting now.");
    });
  });

  it("keeps Git and npm outside the credential-bearing deployment path", async () => {
    await withCheckout(async ({ cwd, head }) => {
      expect(run(cwd, "create").status).toBe(0);
      const bin = join(cwd, "node_modules", ".bin");
      const wrangler = join(bin, "wrangler");
      const gitMarker = join(cwd, "git-was-invoked");
      await mkdir(bin, { recursive: true });
      await writeFile(
        join(bin, "git"),
        `#!${process.execPath}\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(gitMarker)}, "called\\n");\nprocess.exit(91);\n`,
      );
      await writeFile(
        wrangler,
        `#!${process.execPath}\nif (process.env.CLOUDFLARE_API_TOKEN !== "credential-canary") process.exit(92);\n`,
      );
      await chmod(join(bin, "git"), 0o755);
      await chmod(wrangler, 0o755);

      const result = run(cwd, "deploy", head, {
        ...(await stagingDeploymentDigests(cwd)),
        CLOUDFLARE_API_TOKEN: "credential-canary",
        PATH: bin,
      });

      expect(result.status, result.stderr).toBe(0);
      await expect(readFile(gitMarker)).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("requires externally approved artifact digests for deployment", async () => {
    await withCheckout(async ({ cwd, head }) => {
      expect(run(cwd, "create").status).toBe(0);

      const result = run(cwd, "deploy", head);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "STAGING_BUNDLE_SHA256 must be an approved lowercase SHA-256 digest.",
      );
    });
  });

  it("rejects self-consistent artifact replacement after preparation", async () => {
    await withCheckout(async ({ cwd, head }) => {
      expect(run(cwd, "create").status).toBe(0);
      const approvedDigests = await stagingDeploymentDigests(cwd);
      const bundle = Buffer.from("tampered bundle\n");
      const config = Buffer.from('{"name":"tampered"}\n');
      const manifestPath = join(cwd, "dist", "staging-bundle-manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.sha256 = createHash("sha256").update(bundle).digest("hex");
      manifest.size = bundle.length;
      manifest.configSha256 = createHash("sha256").update(config).digest("hex");
      manifest.configSize = config.length;
      await writeFile(join(cwd, "dist", "index.js"), bundle);
      await writeFile(join(cwd, "wrangler.jsonc"), config);
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

      const result = run(cwd, "deploy", head, approvedDigests);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "The staging bundle manifest does not match the approved artifact digests.",
      );
    });
  });

  it("cleans up the private directory when its bundle copy is removed", async () => {
    await withCheckout(async ({ cwd, head }) => {
      const bin = join(cwd, "node_modules", ".bin");
      const wrangler = join(bin, "wrangler");
      await mkdir(bin, { recursive: true });
      await writeFile(
        wrangler,
        `#!/usr/bin/env node
import { chmodSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
chmodSync(dirname(process.argv[3]), 0o700);
unlinkSync(process.argv[3]);
`,
      );
      await chmod(wrangler, 0o755);
      expect(run(cwd, "create").status).toBe(0);
      const before = new Set(
        (await readdir(tmpdir())).filter((name) =>
          name.startsWith("connectwise-staging-deploy-"),
        ),
      );

      const result = run(
        cwd,
        "deploy",
        head,
        await stagingDeploymentDigests(cwd),
      );
      const after = (await readdir(tmpdir())).filter((name) =>
        name.startsWith("connectwise-staging-deploy-"),
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "Wrangler did not deploy the verified staging bundle.",
      );
      expect(after.filter((name) => !before.has(name))).toEqual([]);
    });
  });

  it("rejects a manifest bound to a different approved release", async () => {
    await withCheckout(async ({ cwd }) => {
      expect(run(cwd, "create").status).toBe(0);

      const result = run(cwd, "verify", "0".repeat(40));

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "STAGING_RELEASE_SHA does not match the staging bundle checkout.",
      );
    });
  });

  it.each([undefined, "abc", "A".repeat(40)])(
    "rejects a missing or malformed approved release SHA (%s)",
    async (releaseSha) => {
      await withCheckout(async ({ cwd }) => {
        expect(run(cwd, "create").status).toBe(0);

        const result = run(cwd, "verify", releaseSha);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
          "STAGING_RELEASE_SHA must be the approved full 40-character lowercase release commit.",
        );
      });
    },
  );
});

describe("production bundle integrity", () => {
  it("uses a separately named manifest bound to PRODUCTION_RELEASE_SHA", async () => {
    await withCheckout(async ({ cwd, head }) => {
      const created = run(cwd, "create", undefined, {}, "production");
      const verified = run(
        cwd,
        "verify",
        head,
        { STAGING_RELEASE_SHA: "0".repeat(40) },
        "production",
      );
      const manifest = JSON.parse(
        await readFile(
          join(cwd, "dist", "production-bundle-manifest.json"),
          "utf8",
        ),
      );

      expect(created.status, created.stderr).toBe(0);
      expect(verified.status, verified.stderr).toBe(0);
      expect(manifest.schemaVersion).toBe(3);
      expect(manifest.target).toBe("production");
      expect(manifest.releaseCommit).toBe(head);
      expect(manifest.bundlePath).toBe("dist/index.js");
      expect(manifest.configPath).toBe("wrangler.jsonc");
      await expect(
        readFile(join(cwd, "dist", "staging-bundle-manifest.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("rejects a manifest bound to a different deployment target", async () => {
    await withCheckout(async ({ cwd, head }) => {
      expect(run(cwd, "create", undefined, {}, "production").status).toBe(0);
      const manifestPath = join(cwd, "dist", "production-bundle-manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.target = "staging";
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

      const result = run(cwd, "verify", head, {}, "production");

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "The production bundle manifest has an invalid schema.",
      );
    });
  });

  it("passes exact top-level production arguments and private verified files", async () => {
    await withCheckout(async ({ cwd, head }) => {
      const bin = join(cwd, "node_modules", ".bin");
      const wrangler = join(bin, "wrangler");
      await mkdir(bin, { recursive: true });
      await writeFile(
        wrangler,
        `#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
const args = process.argv.slice(2);
if (args[0] !== "deploy" || args[2] !== "--no-bundle" || args[3] !== "--config") process.exit(2);
if (dirname(resolve(args[4])) !== process.cwd()) process.exit(3);
if (args.includes("staging") || args.some((value) => value === "--env=staging")) process.exit(4);
if (args[args.indexOf("--env") + 1] !== "") process.exit(5);
const expectedFlags = ["--env", "--keep-vars", "--strict", "--env-file", "--tag", "--message", "--dry-run"];
for (const flag of expectedFlags) if (!args.includes(flag)) process.exit(6);
const environmentPath = args[args.indexOf("--env-file") + 1];
if (readFileSync(environmentPath).length !== 0) process.exit(7);
if (args[args.indexOf("--tag") + 1] !== ${JSON.stringify(head)}) process.exit(8);
if (args[args.indexOf("--message") + 1] !== ${JSON.stringify(`ConnectwiseMCP production release ${head}`)}) process.exit(9);
if (!readFileSync(args[1], "utf8").includes("export default")) process.exit(10);
if (!readFileSync(args[4], "utf8").includes("connectwise-staging-bundle-test")) process.exit(11);
`,
      );
      await chmod(wrangler, 0o755);
      expect(run(cwd, "create", undefined, {}, "production").status).toBe(0);

      const result = run(cwd, "dry-run", head, {}, "production");

      expect(result.status, result.stderr).toBe(0);
      const privateConfigs = (await readdir(cwd)).filter((name) =>
        name.startsWith(".wrangler.production-deploy-"),
      );
      expect(privateConfigs).toEqual([]);
    });
  });

  it.each([undefined, "abc", "A".repeat(40)])(
    "rejects a missing or malformed production SHA (%s)",
    async (releaseSha) => {
      await withCheckout(async ({ cwd }) => {
        expect(run(cwd, "create", undefined, {}, "production").status).toBe(0);

        const result = run(cwd, "verify", releaseSha, {}, "production");

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
          "PRODUCTION_RELEASE_SHA must be the approved full 40-character lowercase release commit.",
        );
      });
    },
  );

  it("fails closed when production deployment is requested directly", async () => {
    await withCheckout(async ({ cwd, head }) => {
      const result = run(cwd, "deploy", head, {}, "production");

      expect(result.status).toBe(1);
      expect(result.stderr).toBe(
        "Production deployment is disabled until reviewed live configuration replaces the repository placeholders.\n",
      );
    });
  });

  it.each(["prod", "Production", "staging-extra"])(
    "rejects unsupported target %s",
    async (target) => {
      await withCheckout(async ({ cwd }) => {
        const result = run(cwd, "create", undefined, {}, target);

        expect(result.status).toBe(1);
        expect(result.stderr).toBe(
          "Usage: node scripts/staging-bundle-integrity.mjs <create|verify|deploy|dry-run> [staging|production]\n",
        );
      });
    },
  );
});
