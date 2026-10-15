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
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const integrityPath = fileURLToPath(
  new URL("../scripts/staging-bundle-integrity.mjs", import.meta.url),
);
const deploymentLauncherPath = fileURLToPath(
  new URL("../scripts/deploy-verified-bundle.sh", import.meta.url),
);
const deploymentBootstrapPath = fileURLToPath(
  new URL("../scripts/bootstrap-verified-deployment.sh", import.meta.url),
);
const reviewedLauncherSha256 = createHash("sha256")
  .update(await readFile(deploymentLauncherPath))
  .digest("hex");
const reviewedIntegritySha256 = createHash("sha256")
  .update(await readFile(integrityPath))
  .digest("hex");
const projectNodeModules = fileURLToPath(
  new URL("../node_modules", import.meta.url),
);
const unsafeDeploymentEnvironment = [
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_DEBUG",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "DYLD_FRAMEWORK_PATH",
  "DYLD_FALLBACK_LIBRARY_PATH",
  "DYLD_FALLBACK_FRAMEWORK_PATH",
  "BASH_ENV",
  "ENV",
  "CLOUDFLARE_API_BASE_URL",
  "CF_API_BASE_URL",
  "CLOUDFLARE_BASE_URL",
  "CLOUDFLARE_CONTAINER_REGISTRY",
  "WRANGLER_API_ENVIRONMENT",
  "CLOUDFLARE_COMPLIANCE_REGION",
  "WRANGLER_AUTH_DOMAIN",
  "WRANGLER_AUTH_URL",
  "WRANGLER_TOKEN_URL",
  "WRANGLER_REVOKE_URL",
  "CLOUDFLARE_ACCOUNT_ID",
  "CF_ACCOUNT_ID",
  "WRANGLER_LOG",
  "WRANGLER_LOG_SANITIZE",
  "WRANGLER_LOG_PATH",
  "WRANGLER_WRITE_LOGS",
  "WRANGLER_OUTPUT_FILE_PATH",
  "WRANGLER_OUTPUT_FILE_DIRECTORY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "OPENSSL_CONF",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "CURL_CA_BUNDLE",
];
const observableUnsafeDeploymentEnvironment =
  unsafeDeploymentEnvironment.filter(
    (name) => !(process.platform === "darwin" && name.startsWith("DYLD_")),
  );

function cleanDeploymentEnvironment() {
  const env = { ...process.env };
  for (const name of unsafeDeploymentEnvironment) delete env[name];
  return env;
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

async function createCheckout() {
  const cwd = await mkdtemp(join(tmpdir(), "cw-staging-bundle-"));
  await mkdir(join(cwd, "dist"));
  await mkdir(join(cwd, "scripts"));
  await writeFile(
    join(cwd, "scripts", "staging-bundle-integrity.mjs"),
    await readFile(integrityPath),
  );
  await writeFile(
    join(cwd, "scripts", "deploy-verified-bundle.sh"),
    await readFile(deploymentLauncherPath),
  );
  await chmod(join(cwd, "scripts", "deploy-verified-bundle.sh"), 0o644);
  await writeFile(join(cwd, "release.txt"), "reviewed\n");
  await writeFile(join(cwd, "package-lock.json"), "{}\n");
  await writeFile(join(cwd, "dist", "index.js"), "export default {};\n");
  await writeFile(
    join(cwd, "wrangler.jsonc"),
    JSON.stringify({
      name: "connectwise-staging-bundle-test",
      compatibility_date: "2026-09-01",
      env: { staging: { name: "connectwise-staging-bundle-test-staging" } },
    }),
  );
  const bin = join(cwd, "node_modules", ".bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "wrangler"), `#!${process.execPath}\n`);
  await chmod(join(bin, "wrangler"), 0o755);
  git(cwd, ["init", "--quiet"]);
  git(cwd, ["config", "user.name", "Staging Bundle Test"]);
  git(cwd, ["config", "user.email", "staging-bundle@example.invalid"]);
  git(cwd, ["add", "release.txt", "package-lock.json", "wrangler.jsonc"]);
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
  const env = cleanDeploymentEnvironment();
  delete env.STAGING_RELEASE_SHA;
  delete env.PRODUCTION_RELEASE_SHA;
  delete env.STAGING_BUNDLE_SHA256;
  delete env.STAGING_CONFIG_SHA256;
  delete env.PRODUCTION_BUNDLE_SHA256;
  delete env.PRODUCTION_CONFIG_SHA256;
  delete env.STAGING_DEPLOY_RUNTIME_SHA256;
  delete env.PRODUCTION_DEPLOY_RUNTIME_SHA256;
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

function runLauncher(
  cwd,
  releaseSha,
  environmentOverrides = {},
  invocationCwd = cwd,
) {
  const env = cleanDeploymentEnvironment();
  delete env.DEPLOY_NODE_PATH;
  delete env.STAGING_RELEASE_SHA;
  delete env.STAGING_BUNDLE_SHA256;
  delete env.STAGING_CONFIG_SHA256;
  delete env.STAGING_DEPLOY_RUNTIME_SHA256;
  delete env.STAGING_LAUNCHER_SHA256;
  delete env.STAGING_INTEGRITY_SHA256;
  env.DEPLOY_NODE_PATH = process.execPath;
  env.STAGING_LAUNCHER_SHA256 = reviewedLauncherSha256;
  env.STAGING_INTEGRITY_SHA256 = reviewedIntegritySha256;
  Object.assign(env, environmentOverrides);
  if (releaseSha !== undefined) env.STAGING_RELEASE_SHA = releaseSha;
  return spawnSync(deploymentBootstrapPath, [], {
    cwd: invocationCwd,
    env,
    encoding: "utf8",
  });
}

function runSecret(
  cwd,
  secretName,
  releaseSha,
  environmentOverrides = {},
  additionalArguments = [],
) {
  const env = cleanDeploymentEnvironment();
  for (const name of [
    "STAGING_RELEASE_SHA",
    "STAGING_BUNDLE_SHA256",
    "STAGING_CONFIG_SHA256",
    "STAGING_DEPLOY_RUNTIME_SHA256",
  ]) {
    delete env[name];
  }
  Object.assign(env, environmentOverrides);
  if (releaseSha !== undefined) env.STAGING_RELEASE_SHA = releaseSha;
  return spawnSync(
    process.execPath,
    [integrityPath, "secret", secretName, ...additionalArguments],
    { cwd, env, encoding: "utf8" },
  );
}

async function stagingDeploymentDigests(cwd) {
  const manifest = JSON.parse(
    await readFile(join(cwd, "dist", "staging-bundle-manifest.json"), "utf8"),
  );
  return {
    STAGING_BUNDLE_SHA256: manifest.sha256,
    STAGING_CONFIG_SHA256: manifest.configSha256,
    STAGING_DEPLOY_RUNTIME_SHA256: manifest.runtimeSha256,
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
          `^Recorded staging bundle [0-9a-f]{64}, configuration [0-9a-f]{64}, deployment runtime [0-9a-f]{64}, deployment launcher ${reviewedLauncherSha256}, and deployment entrypoint ${reviewedIntegritySha256} for ${head}\\.\\n$`,
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

  it("rejects a runtime inventory modified after manifest creation", async () => {
    await withCheckout(async ({ cwd, head }) => {
      expect(run(cwd, "create").status).toBe(0);
      await writeFile(
        join(cwd, "dist", "staging-runtime-inventory.json"),
        "{}\n",
      );

      const result = run(cwd, "verify", head);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "The staging runtime inventory does not match its release manifest.",
      );
    });
  });

  it("rejects a package lock modified after manifest creation", async () => {
    await withCheckout(async ({ cwd, head }) => {
      expect(run(cwd, "create").status).toBe(0);
      await writeFile(join(cwd, "package-lock.json"), '{"tampered":true}\n');

      const result = run(cwd, "verify", head);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "The staging package lock does not match its release manifest.",
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

  it("uses an unambiguous deployment-runtime tree digest", async () => {
    let firstDigest;
    await withCheckout(async ({ cwd }) => {
      await writeFile(
        join(cwd, "node_modules", "a"),
        Buffer.concat([
          Buffer.from("file"),
          Buffer.from([0]),
          Buffer.from("b"),
          Buffer.from([0]),
          Buffer.from("420"),
          Buffer.from([0]),
          Buffer.from("payload"),
        ]),
      );
      expect(run(cwd, "create").status).toBe(0);
      firstDigest = JSON.parse(
        await readFile(
          join(cwd, "dist", "staging-bundle-manifest.json"),
          "utf8",
        ),
      ).runtimeSha256;
    });
    await withCheckout(async ({ cwd }) => {
      await writeFile(join(cwd, "node_modules", "a"), "");
      await writeFile(join(cwd, "node_modules", "b"), "payload");
      expect(run(cwd, "create").status).toBe(0);
      const secondDigest = JSON.parse(
        await readFile(
          join(cwd, "dist", "staging-bundle-manifest.json"),
          "utf8",
        ),
      ).runtimeSha256;
      expect(secondDigest).not.toBe(firstDigest);
    });
  });

  it("rejects absolute deployment-runtime symlinks", async () => {
    await withCheckout(async ({ cwd }) => {
      const targetPath = join(cwd, "node_modules", "target.js");
      await writeFile(targetPath, "export {};\n");
      await symlink(targetPath, join(cwd, "node_modules", "absolute-link.js"));

      const result = run(cwd, "create");

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "The staging deployment runtime link absolute-link.js must be relative.",
      );
    });
  });

  it("rejects a deployment runtime outside the release checkout", async () => {
    await withCheckout(async ({ cwd }) => {
      await rm(join(cwd, "node_modules"), { recursive: true, force: true });
      await symlink(projectNodeModules, join(cwd, "node_modules"), "dir");

      const result = run(cwd, "create");

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "The staging deployment runtime must remain inside the checkout.",
      );
    });
  });

  it("rejects Node preload injection before exposing deployment credentials", async () => {
    await withCheckout(async ({ cwd, head }) => {
      const wrangler = join(cwd, "node_modules", ".bin", "wrangler");
      const preload = join(cwd, "preload.mjs");
      const preloadMarker = join(cwd, "preload-ran");
      const wranglerMarker = join(cwd, "wrangler-ran");
      await writeFile(
        preload,
        `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(preloadMarker)}, process.env.CLOUDFLARE_API_TOKEN ?? "missing");\n`,
      );
      await writeFile(
        wrangler,
        `#!${process.execPath}\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(wranglerMarker)}, process.env.CLOUDFLARE_API_TOKEN ?? "missing");\n`,
      );
      await chmod(wrangler, 0o755);
      expect(run(cwd, "create").status).toBe(0);

      const result = runLauncher(cwd, head, {
        ...(await stagingDeploymentDigests(cwd)),
        CLOUDFLARE_API_TOKEN: "credential-canary",
        NODE_OPTIONS: `--import=${preload}`,
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "Refusing credential-bearing deployment while Node injection or debug settings are present.",
      );
      await expect(readFile(preloadMarker)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(readFile(wranglerMarker)).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("ignores inherited exported shell functions before authenticating the launcher", async () => {
    await withCheckout(async ({ cwd }) => {
      const marker = join(cwd, "exported-shell-function-ran");
      const result = runLauncher(cwd, undefined, {
        "BASH_FUNC_pwd%%": `() { printf "%s" "$CLOUDFLARE_API_TOKEN" > ${JSON.stringify(marker)}; builtin pwd; }`,
        CLOUDFLARE_API_TOKEN: "credential-canary",
        STAGING_LAUNCHER_SHA256: "0".repeat(64),
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "The deployment launcher does not match the retained reviewed digest",
      );
      expect(result.stderr).not.toContain("credential-canary");
      await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("rejects a bootstrap invoked outside its physical reviewed repository root", async () => {
    await withCheckout(async ({ cwd }) => {
      const fakeMarker = join(cwd, "fake-entrypoint-ran");
      await writeFile(
        join(cwd, "scripts", "staging-bundle-integrity.mjs"),
        `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(fakeMarker)}, process.env.CLOUDFLARE_API_TOKEN ?? "missing");\n`,
      );

      const result = runLauncher(
        cwd,
        undefined,
        { CLOUDFLARE_API_TOKEN: "credential-canary" },
        join(cwd, "scripts"),
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(
        /Run the independently retained deployment bootstrap|deployment launcher must remain a regular/,
      );
      await expect(readFile(fakeMarker)).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("keeps the repository launcher non-executable outside the bootstrap", async () => {
    await withCheckout(async ({ cwd }) => {
      const marker = join(cwd, "direct-launcher-ran");
      const launcher = join(cwd, "scripts", "deploy-verified-bundle.sh");
      await writeFile(
        launcher,
        `#!/bin/sh\nprintf "$CLOUDFLARE_API_TOKEN" > ${JSON.stringify(marker)}\n`,
      );
      const env = cleanDeploymentEnvironment();
      env.CLOUDFLARE_API_TOKEN = "credential-canary";

      const result = spawnSync(launcher, [], { cwd, env, encoding: "utf8" });

      expect(result.status).toBeNull();
      expect(result.error).toMatchObject({ code: "EACCES" });
      await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("rejects any executable mode bit even when the launcher digest matches", async () => {
    await withCheckout(async ({ cwd }) => {
      const launcher = join(cwd, "scripts", "deploy-verified-bundle.sh");
      await chmod(launcher, 0o645);

      const result = runLauncher(cwd, undefined, {
        CLOUDFLARE_API_TOKEN: "credential-canary",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "The deployment launcher does not match the retained reviewed digest or has an unsafe file type.",
      );
      expect(result.stderr).not.toContain("credential-canary");
    });
  });

  it("rejects a modified launcher before it can observe deployment credentials", async () => {
    await withCheckout(async ({ cwd }) => {
      const marker = join(cwd, "modified-launcher-ran");
      await writeFile(
        join(cwd, "scripts", "deploy-verified-bundle.sh"),
        `#!/bin/sh\nprintf '%s' "$CLOUDFLARE_API_TOKEN" > ${JSON.stringify(marker)}\n`,
      );
      await chmod(join(cwd, "scripts", "deploy-verified-bundle.sh"), 0o644);

      const result = runLauncher(cwd, undefined, {
        CLOUDFLARE_API_TOKEN: "credential-canary",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "The deployment launcher does not match the retained reviewed digest or has an unsafe file type.",
      );
      expect(result.stdout).not.toContain("credential-canary");
      expect(result.stderr).not.toContain("credential-canary");
      await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it.each(["symlink", "hard link"])(
    "rejects a %s deployment launcher before it can observe credentials",
    async (fileType) => {
      await withCheckout(async ({ cwd }) => {
        const launcher = join(cwd, "scripts", "deploy-verified-bundle.sh");
        const replacement = join(cwd, "replacement-launcher.sh");
        await writeFile(replacement, await readFile(launcher));
        await chmod(replacement, 0o755);
        await unlink(launcher);
        if (fileType === "symlink") await symlink(replacement, launcher);
        else await link(replacement, launcher);

        const result = runLauncher(cwd, undefined, {
          CLOUDFLARE_API_TOKEN: "credential-canary",
        });

        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(
          /deployment launcher (must remain a regular|does not match the retained reviewed digest)/i,
        );
        expect(result.stderr).not.toContain("credential-canary");
      });
    },
  );

  it.each(["", "abc", "A".repeat(64), `${"a".repeat(63)}g`])(
    "rejects a missing or malformed retained launcher digest (%s)",
    async (digest) => {
      await withCheckout(async ({ cwd }) => {
        const result = runLauncher(cwd, undefined, {
          STAGING_LAUNCHER_SHA256: digest,
        });

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
          "STAGING_LAUNCHER_SHA256 must be the retained lowercase SHA-256",
        );
      });
    },
  );

  it("executes authenticated launcher bytes instead of a replacement path", async () => {
    await withCheckout(async ({ cwd }) => {
      const launcher = join(cwd, "scripts", "deploy-verified-bundle.sh");
      const authenticatedMarker = join(cwd, "authenticated-launcher-ran");
      const replacementMarker = join(cwd, "replacement-launcher-ran");
      const replacement = `#!/bin/sh\nprintf "$CLOUDFLARE_API_TOKEN" > ${JSON.stringify(replacementMarker)}\n`;
      const authenticated = `#!/bin/sh\nprintf '%s' '${replacement}' > scripts/deploy-verified-bundle.sh\nprintf 'authenticated' > ${JSON.stringify(authenticatedMarker)}\n`;
      await writeFile(launcher, authenticated);
      await chmod(launcher, 0o644);
      const digest = createHash("sha256").update(authenticated).digest("hex");

      const result = runLauncher(cwd, undefined, {
        CLOUDFLARE_API_TOKEN: "credential-canary",
        STAGING_LAUNCHER_SHA256: digest,
      });

      expect(result.status, result.stderr).toBe(0);
      await expect(readFile(authenticatedMarker, "utf8")).resolves.toBe(
        "authenticated",
      );
      await expect(readFile(replacementMarker)).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("rejects a changed deployment entrypoint before executing it", async () => {
    await withCheckout(async ({ cwd }) => {
      const marker = join(cwd, "changed-entrypoint-ran");
      await writeFile(
        join(cwd, "scripts", "staging-bundle-integrity.mjs"),
        `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, process.env.CLOUDFLARE_API_TOKEN ?? "missing");\n`,
      );

      const result = runLauncher(cwd, undefined, {
        CLOUDFLARE_API_TOKEN: "credential-canary",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "The deployment entrypoint does not match the retained reviewed digest or has an unsafe file type.",
      );
      await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it.each(["symlink", "hard link"])(
    "rejects a %s deployment entrypoint before executing it",
    async (fileType) => {
      await withCheckout(async ({ cwd }) => {
        const entrypoint = join(cwd, "scripts", "staging-bundle-integrity.mjs");
        const replacement = join(cwd, "replacement-integrity.mjs");
        await writeFile(replacement, await readFile(entrypoint));
        await unlink(entrypoint);
        if (fileType === "symlink") await symlink(replacement, entrypoint);
        else await link(replacement, entrypoint);

        const result = runLauncher(cwd, undefined, {
          CLOUDFLARE_API_TOKEN: "credential-canary",
        });

        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(
          /deployment entrypoint must be a regular|deployment entrypoint does not match/i,
        );
      });
    },
  );

  it.each(["", "abc", "A".repeat(64), `${"a".repeat(63)}g`])(
    "rejects a missing or malformed retained entrypoint digest (%s)",
    async (digest) => {
      await withCheckout(async ({ cwd }) => {
        const result = runLauncher(cwd, undefined, {
          STAGING_INTEGRITY_SHA256: digest,
        });

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
          "STAGING_INTEGRITY_SHA256 must be the retained lowercase SHA-256",
        );
      });
    },
  );

  it("runs the verified deployment with Node injection variables absent", async () => {
    await withCheckout(async ({ cwd, head }) => {
      const wrangler = join(cwd, "node_modules", ".bin", "wrangler");
      const marker = join(cwd, "wrangler-ran");
      await writeFile(
        wrangler,
        `#!${process.execPath}\nimport { writeFileSync } from "node:fs";\nconst blocked = ${JSON.stringify(unsafeDeploymentEnvironment)};\nif (blocked.some((name) => Object.hasOwn(process.env, name))) process.exit(94);\nwriteFileSync(${JSON.stringify(marker)}, process.env.CLOUDFLARE_API_TOKEN ?? "missing");\n`,
      );
      await chmod(wrangler, 0o755);
      expect(run(cwd, "create").status).toBe(0);

      const result = runLauncher(cwd, head, {
        ...(await stagingDeploymentDigests(cwd)),
        CLOUDFLARE_API_TOKEN: "credential-canary",
      });

      expect(result.status, result.stderr).toBe(0);
      await expect(readFile(marker, "utf8")).resolves.toBe("credential-canary");
    });
  });

  it("rejects an inherited Node module search path", async () => {
    await withCheckout(async ({ cwd }) => {
      const result = runLauncher(cwd, undefined, { NODE_PATH: cwd });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "Refusing credential-bearing deployment while Node injection or debug settings are present.",
      );
    });
  });

  it.each(
    observableUnsafeDeploymentEnvironment.filter(
      (name) => name !== "NODE_OPTIONS" && name !== "NODE_PATH",
    ),
  )("rejects the %s override before the launcher starts Node", async (name) => {
    await withCheckout(async ({ cwd }) => {
      const result = runLauncher(cwd, undefined, { [name]: "hostile-value" });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Refusing credential-bearing deployment");
    });
  });

  it("rejects even an empty unsafe override", async () => {
    await withCheckout(async ({ cwd }) => {
      const result = runLauncher(cwd, undefined, {
        CLOUDFLARE_API_BASE_URL: "",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "Cloudflare endpoint or account override is present",
      );
    });
  });

  it.each(
    observableUnsafeDeploymentEnvironment.filter(
      (name) => name !== "NODE_OPTIONS" && name !== "NODE_PATH",
    ),
  )("rejects direct deploy when %s bypasses the launcher", async (name) => {
    await withCheckout(async ({ cwd }) => {
      const result = run(cwd, "deploy", undefined, {
        [name]: "hostile-value",
        CLOUDFLARE_API_TOKEN: "credential-canary",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "Refusing credential-bearing deployment while an unsafe environment override is present.",
      );
    });
  });

  it("does not resolve Node or Wrangler through an inherited PATH", async () => {
    await withCheckout(async ({ cwd, head }) => {
      const hostileBin = join(cwd, "hostile-bin");
      const nodeMarker = join(cwd, "path-node-ran");
      const wranglerMarker = join(cwd, "wrangler-ran");
      const wrangler = join(cwd, "node_modules", ".bin", "wrangler");
      await mkdir(hostileBin);
      await writeFile(
        join(hostileBin, "node"),
        `#!/bin/sh\nprintf '%s' "$CLOUDFLARE_API_TOKEN" > ${JSON.stringify(nodeMarker)}\nexit 73\n`,
      );
      await chmod(join(hostileBin, "node"), 0o755);
      await writeFile(
        wrangler,
        `#!${process.execPath}\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(wranglerMarker)}, process.env.CLOUDFLARE_API_TOKEN ?? "missing");\n`,
      );
      await chmod(wrangler, 0o755);
      expect(run(cwd, "create").status).toBe(0);

      const result = runLauncher(cwd, head, {
        ...(await stagingDeploymentDigests(cwd)),
        CLOUDFLARE_API_TOKEN: "credential-canary",
        PATH: `${hostileBin}:${process.env.PATH ?? ""}`,
      });

      expect(result.status, result.stderr).toBe(0);
      await expect(readFile(nodeMarker)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(readFile(wranglerMarker, "utf8")).resolves.toBe(
        "credential-canary",
      );
    });
  });

  it.each([
    ["missing", ""],
    ["relative", "node"],
  ])("rejects a %s approved Node path", async (_label, nodePath) => {
    await withCheckout(async ({ cwd }) => {
      const result = runLauncher(cwd, undefined, {
        DEPLOY_NODE_PATH: nodePath,
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "DEPLOY_NODE_PATH must name the approved absolute Node executable.",
      );
    });
  });

  it("rejects symlinked and non-executable approved Node paths", async () => {
    await withCheckout(async ({ cwd }) => {
      const nodeLink = join(cwd, "node-link");
      const nonExecutable = join(cwd, "node-not-executable");
      await symlink(process.execPath, nodeLink);
      await writeFile(nonExecutable, "not executable\n");
      await chmod(nonExecutable, 0o600);

      for (const nodePath of [nodeLink, nonExecutable]) {
        const result = runLauncher(cwd, undefined, {
          DEPLOY_NODE_PATH: nodePath,
        });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
          "DEPLOY_NODE_PATH must be a regular, non-symlink executable.",
        );
      }
    });
  });

  it.each([
    [
      "dot component",
      `${dirname(process.execPath)}/./${basename(process.execPath)}`,
    ],
    [
      "repeated separator",
      `${dirname(process.execPath)}//${basename(process.execPath)}`,
    ],
    ["leading double slash", `/${process.execPath}`],
  ])(
    "rejects a Node path with a non-canonical %s",
    async (_label, nodePath) => {
      await withCheckout(async ({ cwd }) => {
        const result = runLauncher(cwd, undefined, {
          DEPLOY_NODE_PATH: nodePath,
        });

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
          "DEPLOY_NODE_PATH must not contain symlinked or non-canonical path components.",
        );
      });
    },
  );

  it("rejects an approved Node path with a symlinked parent", async () => {
    await withCheckout(async ({ cwd }) => {
      const nodeParentLink = join(cwd, "node-parent-link");
      await symlink(dirname(process.execPath), nodeParentLink, "dir");

      const result = runLauncher(cwd, undefined, {
        DEPLOY_NODE_PATH: join(nodeParentLink, basename(process.execPath)),
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "DEPLOY_NODE_PATH must not contain symlinked or non-canonical path components.",
      );
    });
  });

  it.each([
    ["Wrangler shim", join("node_modules", ".bin", "wrangler")],
    ["Wrangler implementation", join("node_modules", "wrangler", "cli.js")],
  ])(
    "rejects a mutated %s before exposing deployment credentials",
    async (_label, runtimePath) => {
      await withCheckout(async ({ cwd, head }) => {
        if (runtimePath.includes(`${join("wrangler", "cli.js")}`)) {
          await mkdir(join(cwd, "node_modules", "wrangler"), {
            recursive: true,
          });
          await writeFile(
            join(cwd, "node_modules", "wrangler", "cli.js"),
            "export {};\n",
          );
        }
        expect(run(cwd, "create").status).toBe(0);
        const approvedDigests = await stagingDeploymentDigests(cwd);
        const marker = join(cwd, "credential-was-exposed");
        await writeFile(
          join(cwd, runtimePath),
          `#!${process.execPath}\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, process.env.CLOUDFLARE_API_TOKEN ?? "missing");\n`,
        );
        await chmod(join(cwd, runtimePath), 0o755);

        const result = run(cwd, "deploy", head, {
          ...approvedDigests,
          CLOUDFLARE_API_TOKEN: "credential-canary",
        });

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
          "The staging deployment runtime does not match its release manifest.",
        );
        await expect(readFile(marker)).rejects.toMatchObject({
          code: "ENOENT",
        });
      });
    },
  );

  it("keeps Git and npm outside the credential-bearing deployment path", async () => {
    await withCheckout(async ({ cwd, head }) => {
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
        `#!${process.execPath}\nif (process.env.CLOUDFLARE_API_TOKEN !== "credential-canary") process.exit(92);\nif (import.meta.url.includes(${JSON.stringify(join(cwd, "node_modules"))})) process.exit(93);\n`,
      );
      await chmod(join(bin, "git"), 0o755);
      await chmod(wrangler, 0o755);
      expect(run(cwd, "create").status).toBe(0);

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

  it("accepts exactly one approved staging secret name", async () => {
    await withCheckout(async ({ cwd }) => {
      for (const [name, additionalArguments] of [
        ["ARBITRARY_SECRET", []],
        ["CW_PROFILE_", []],
        ["CW_PROFILE_lower", []],
        [`CW_PROFILE_A${"1".repeat(32)}`, []],
        ["ENTRA_CLIENT_SECRET", ["--env", "production"]],
      ]) {
        const result = runSecret(cwd, name, undefined, {}, additionalArguments);
        expect(result.status).toBe(1);
        expect(result.stderr).toBe(
          "Usage: node scripts/staging-bundle-integrity.mjs <create|verify|deploy|dry-run> [staging|production]\n",
        );
      }
    });
  });

  it("requires externally approved artifact digests for staging secret entry", async () => {
    await withCheckout(async ({ cwd, head }) => {
      expect(run(cwd, "create").status).toBe(0);

      const result = runSecret(cwd, "ENTRA_CLIENT_SECRET", head);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "STAGING_BUNDLE_SHA256 must be an approved lowercase SHA-256 digest.",
      );
    });
  });

  it("uses approved artifacts and a private read-only runtime and config for secret entry", async () => {
    await withCheckout(async ({ cwd, head }) => {
      const wrangler = join(cwd, "node_modules", ".bin", "wrangler");
      const marker = join(cwd, "secret-entry.json");
      await writeFile(
        wrangler,
        `#!${process.execPath}
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
const args = process.argv.slice(2);
const config = args[args.indexOf("--config") + 1];
const runtime = dirname(dirname(process.argv[1]));
writeFileSync(process.env.SECRET_MARKER, JSON.stringify({
  args,
  config,
  configBytes: readFileSync(config, "utf8"),
  configMode: statSync(config).mode & 0o777,
  entrypoint: process.argv[1],
  runtime,
  runtimeMode: statSync(runtime).mode & 0o777,
}));
`,
      );
      await chmod(wrangler, 0o755);
      expect(run(cwd, "create").status).toBe(0);

      const result = runSecret(cwd, "ENTRA_CLIENT_SECRET", head, {
        ...(await stagingDeploymentDigests(cwd)),
        SECRET_MARKER: marker,
      });
      const captured = JSON.parse(await readFile(marker, "utf8"));

      expect(result.status, result.stderr).toBe(0);
      expect(captured.args).toEqual([
        "secret",
        "put",
        "ENTRA_CLIENT_SECRET",
        "--env",
        "staging",
        "--config",
        captured.config,
      ]);
      expect(captured.configBytes).toContain("connectwise-staging-bundle-test");
      expect(captured.configMode).toBe(0o400);
      expect(captured.runtimeMode).toBe(0o500);
      expect(captured.entrypoint).not.toContain(join(cwd, "node_modules"));
      await expect(readFile(captured.config)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(readdir(captured.runtime)).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("rejects runtime mutation before exposing secret-entry credentials", async () => {
    await withCheckout(async ({ cwd, head }) => {
      const wrangler = join(cwd, "node_modules", ".bin", "wrangler");
      const marker = join(cwd, "secret-was-exposed");
      expect(run(cwd, "create").status).toBe(0);
      const digests = await stagingDeploymentDigests(cwd);
      await writeFile(
        wrangler,
        `#!${process.execPath}\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "exposed");\n`,
      );
      await chmod(wrangler, 0o755);

      const result = runSecret(cwd, "OAUTH_STATE_SECRET", head, digests);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "The staging deployment runtime does not match its release manifest.",
      );
      await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("cleans up private secret-entry artifacts when Wrangler fails", async () => {
    await withCheckout(async ({ cwd, head }) => {
      const wrangler = join(cwd, "node_modules", ".bin", "wrangler");
      const marker = join(cwd, "failed-secret-entry.json");
      await writeFile(
        wrangler,
        `#!${process.execPath}\nimport { writeFileSync } from "node:fs";\nimport { dirname } from "node:path";\nconst args = process.argv.slice(2);\nconst config = args[args.indexOf("--config") + 1];\nwriteFileSync(process.env.SECRET_MARKER, JSON.stringify({ config, runtime: dirname(dirname(process.argv[1])) }));\nprocess.exit(17);\n`,
      );
      await chmod(wrangler, 0o755);
      expect(run(cwd, "create").status).toBe(0);

      const result = runSecret(cwd, "IDENTITY_PROFILE_MAP", head, {
        ...(await stagingDeploymentDigests(cwd)),
        SECRET_MARKER: marker,
      });
      const captured = JSON.parse(await readFile(marker, "utf8"));

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "Wrangler did not put the verified staging secret.",
      );
      await expect(readFile(captured.config)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(readdir(captured.runtime)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(
        (await readdir(cwd)).filter((name) =>
          name.startsWith(".wrangler.staging-secret-"),
        ),
      ).toEqual([]);
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
      expect(manifest.schemaVersion).toBe(5);
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
