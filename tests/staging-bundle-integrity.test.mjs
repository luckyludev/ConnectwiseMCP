import { spawnSync } from "node:child_process";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
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
  git(cwd, ["add", "release.txt"]);
  git(cwd, ["commit", "--quiet", "-m", "reviewed release"]);
  return { cwd, head: git(cwd, ["rev-parse", "HEAD"]) };
}

function run(cwd, action, releaseSha, environmentOverrides = {}) {
  const env = { ...process.env, ...environmentOverrides };
  if (releaseSha === undefined) delete env.STAGING_RELEASE_SHA;
  else env.STAGING_RELEASE_SHA = releaseSha;
  return spawnSync(process.execPath, [integrityPath, action], {
    cwd,
    env,
    encoding: "utf8",
  });
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
        new RegExp(`^Recorded staging bundle [0-9a-f]{64} for ${head}\\.\\n$`),
      );
      expect(verified.status, verified.stderr).toBe(0);
      expect(verified.stdout).toMatch(
        new RegExp(`^Verified staging bundle [0-9a-f]{64} for ${head}\\.\\n$`),
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

      const result = run(cwd, "deploy", head);
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
