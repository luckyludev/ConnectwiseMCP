import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repository = fileURLToPath(new URL("../", import.meta.url));
const launcher = fileURLToPath(
  new URL("../scripts/put-staging-secret.sh", import.meta.url),
);
const integrityEntrypoint = join(
  repository,
  "scripts/staging-bundle-integrity.mjs",
);
const reviewedIntegritySha256 = createHash("sha256")
  .update(await readFile(integrityEntrypoint))
  .digest("hex");
let temporaryDirectory;
let approvedNode;
let capturePath;

function run(args, overrides = {}, cwd = repository) {
  return spawnSync("scripts/put-staging-secret.sh", args, {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      CAPTURE_PATH: capturePath,
      DEPLOY_NODE_PATH: approvedNode,
      STAGING_INTEGRITY_SHA256: reviewedIntegritySha256,
      ...overrides,
    },
  });
}

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(
    join(await realpath(tmpdir()), "cw-staging-secret-"),
  );
  approvedNode = join(temporaryDirectory, "approved-node");
  capturePath = join(temporaryDirectory, "captured-arguments");
  await writeFile(
    approvedNode,
    '#!/bin/sh\nif [ "${TMPDIR+x}" = x ] || [ "${TMP+x}" = x ] || [ "${TEMP+x}" = x ]; then exit 42; fi\nprintf \'%s\\n\' "$@" > "$CAPTURE_PATH"\n',
    { mode: 0o700 },
  );
});

afterEach(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe("staging secret launcher", () => {
  it("passes only approved names to the staging environment", async () => {
    for (const secretName of [
      "ENTRA_CLIENT_SECRET",
      "OAUTH_STATE_SECRET",
      "IDENTITY_PROFILE_MAP",
      "CW_PROFILE_LUIS",
      `CW_PROFILE_A${"1".repeat(31)}`,
    ]) {
      const result = run([secretName]);
      expect(result.status, result.stderr).toBe(0);
      const captured = (await readFile(capturePath, "utf8")).split("\n");
      expect(captured[0]).toBe("-e");
      expect(captured.join("\n")).toContain(
        'import(`data:text/javascript;base64,${bytes.toString("base64")}`)',
      );
      expect(captured.slice(-5)).toEqual([
        launcher,
        integrityEntrypoint,
        reviewedIntegritySha256,
        secretName,
        "",
      ]);
    }
  });

  it("rejects arbitrary names and arguments before invoking Node", async () => {
    for (const args of [
      [],
      ["ARBITRARY_SECRET"],
      ["CW_PROFILE_"],
      ["CW_PROFILE_lower"],
      ["CW_PROFILE_A-B"],
      [`CW_PROFILE_A${"1".repeat(32)}`],
      ["ENTRA_CLIENT_SECRET", "--env", "production"],
    ]) {
      const result = run(args);
      expect(result.status).not.toBe(0);
      await expect(lstat(capturePath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
  });

  it("rejects a leading double slash in the approved Node path", async () => {
    const result = run(["ENTRA_CLIENT_SECRET"], {
      DEPLOY_NODE_PATH: `/${approvedNode}`,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "DEPLOY_NODE_PATH must not contain symlinked or non-canonical path components.",
    );
    await expect(lstat(capturePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("executes authenticated bytes without reopening the repository entrypoint", async () => {
    const result = run(["ENTRA_CLIENT_SECRET"], {
      DEPLOY_NODE_PATH: process.execPath,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(
      /STAGING_RELEASE_SHA must be the approved|The staging bundle directory is missing/,
    );
  });

  it("rejects a missing, malformed, or mismatched retained integrity digest", async () => {
    for (const digest of [undefined, "abc", "A".repeat(64), "0".repeat(64)]) {
      const result = run(["ENTRA_CLIENT_SECRET"], {
        DEPLOY_NODE_PATH: process.execPath,
        STAGING_INTEGRITY_SHA256: digest,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(
        /STAGING_INTEGRITY_SHA256 must be|integrity entrypoint does not match/,
      );
      await expect(lstat(capturePath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
  });

  it("clears temporary-directory overrides before invoking authenticated Node", async () => {
    const result = run(["ENTRA_CLIENT_SECRET"], {
      TMPDIR: "https://attacker.invalid",
      TMP: "https://attacker.invalid",
      TEMP: "https://attacker.invalid",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(capturePath, "utf8")).toContain(
      reviewedIntegritySha256,
    );
  });

  it("rejects non-ASCII profile aliases in a UTF-8 locale", async () => {
    const result = run(["CW_PROFILE_À"], { LC_ALL: "en_US.UTF-8" });
    expect(result.status).not.toBe(0);
    await expect(lstat(capturePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects request-routing and runtime overrides before invoking Node", async () => {
    for (const variable of [
      "NODE_OPTIONS",
      "NODE_PATH",
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
      "https_proxy",
      "NODE_EXTRA_CA_CERTS",
      "NODE_TLS_REJECT_UNAUTHORIZED",
      "OPENSSL_CONF",
      "SSL_CERT_FILE",
      "CURL_CA_BUNDLE",
    ]) {
      for (const value of ["", "https://attacker.invalid"]) {
        const result = run(["ENTRA_CLIENT_SECRET"], { [variable]: value });
        expect(result.status).not.toBe(0);
        await expect(lstat(capturePath)).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
    }
  });

  it("rejects invocation outside the reviewed repository root", async () => {
    const result = run(["ENTRA_CLIENT_SECRET"], {}, temporaryDirectory);
    expect(result.status).not.toBe(0);
    await expect(lstat(capturePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resolves a symlinked working directory to the reviewed repository", async () => {
    const linkedRepository = join(temporaryDirectory, "repository-link");
    await symlink(repository, linkedRepository);
    const result = run(["ENTRA_CLIENT_SECRET"], {}, linkedRepository);
    expect(result.status, result.stderr).toBe(0);
    expect((await readFile(capturePath, "utf8")).split("\n").at(-3)).toBe(
      reviewedIntegritySha256,
    );
  });

  it("rejects invocation through a launcher symlink", async () => {
    const linkedLauncher = join(temporaryDirectory, "linked-launcher");
    await symlink(launcher, linkedLauncher);
    const result = spawnSync(linkedLauncher, ["ENTRA_CLIENT_SECRET"], {
      cwd: repository,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        CAPTURE_PATH: capturePath,
        DEPLOY_NODE_PATH: approvedNode,
        STAGING_INTEGRITY_SHA256: reviewedIntegritySha256,
      },
    });
    expect(result.status).not.toBe(0);
    await expect(lstat(capturePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires an absolute canonical executable path without symlinks", async () => {
    const nonExecutable = join(temporaryDirectory, "non-executable");
    const linkedNode = join(temporaryDirectory, "linked-node");
    const linkedParent = join(temporaryDirectory, "linked-parent");
    await writeFile(nonExecutable, "not executable\n", { mode: 0o600 });
    await chmod(approvedNode, 0o700);
    await symlink(approvedNode, linkedNode);
    await symlink(temporaryDirectory, linkedParent);

    for (const nodePath of [
      "node",
      nonExecutable,
      linkedNode,
      join(linkedParent, "approved-node"),
    ]) {
      const result = run(["ENTRA_CLIENT_SECRET"], {
        DEPLOY_NODE_PATH: nodePath,
      });
      expect(result.status).not.toBe(0);
      await expect(lstat(capturePath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
  });
});
