import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const action = process.argv[2];
const target = process.argv[3] ?? "staging";
if (
  process.argv.length > 4 ||
  (action !== "create" &&
    action !== "verify" &&
    action !== "deploy" &&
    action !== "dry-run") ||
  (target !== "staging" && target !== "production")
) {
  process.stderr.write(
    "Usage: node scripts/staging-bundle-integrity.mjs <create|verify|deploy|dry-run> [staging|production]\n",
  );
  process.exit(1);
}
if (target === "production" && action === "deploy") {
  process.stderr.write(
    "Production deployment is disabled until reviewed live configuration replaces the repository placeholders.\n",
  );
  process.exit(1);
}

const DIST_PATH = "dist";
const BUNDLE_PATH = "dist/index.js";
const CONFIG_PATH = "wrangler.jsonc";
const MANIFEST_PATH = `dist/${target}-bundle-manifest.json`;
const releaseVariable =
  target === "production" ? "PRODUCTION_RELEASE_SHA" : "STAGING_RELEASE_SHA";
const gitEnvironment = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  ),
  GIT_NO_REPLACE_OBJECTS: "1",
};

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function gitHead() {
  const result = spawnSync(
    "git",
    [
      "-c",
      "core.useReplaceRefs=false",
      "-c",
      "core.fsmonitor=false",
      "rev-parse",
      "--verify",
      "HEAD^{commit}",
    ],
    { encoding: "utf8", env: gitEnvironment },
  );
  if (result.status !== 0)
    fail(`Unable to resolve the ${target} bundle commit.`);
  const head = result.stdout.trim();
  if (!/^[0-9a-f]{40}$/u.test(head)) {
    fail(`The ${target} bundle commit is not a canonical Git object ID.`);
  }
  return head;
}

function readCommittedConfig(commit) {
  const result = spawnSync(
    "git",
    [
      "-c",
      "core.useReplaceRefs=false",
      "-c",
      "core.fsmonitor=false",
      "cat-file",
      "blob",
      `${commit}:${CONFIG_PATH}`,
    ],
    { encoding: null, env: gitEnvironment, maxBuffer: 1024 * 1024 },
  );
  if (result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
    fail(
      `Unable to read the ${target} Wrangler configuration from the release commit.`,
    );
  }
  return result.stdout;
}

function requireReleaseConfig(config, releaseCommit) {
  const committedConfig = readCommittedConfig(releaseCommit);
  if (!config.equals(committedConfig)) {
    fail(
      `The ${target} Wrangler configuration does not match the release commit.`,
    );
  }
}

function validateDistDirectory() {
  let stat;
  try {
    stat = lstatSync(DIST_PATH);
  } catch {
    fail(`The ${target} bundle directory is missing.`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail(`The ${target} bundle directory must be a real directory.`);
  }
  if (realpathSync(DIST_PATH) !== resolve(DIST_PATH)) {
    fail(`The ${target} bundle directory must remain inside the checkout.`);
  }
}

function readRegularFile(path, label) {
  let before;
  try {
    before = lstatSync(path);
  } catch {
    fail(`${label} is missing.`);
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    fail(`${label} must be a regular, non-symlink, single-link file.`);
  }

  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      fail(`${label} changed while it was being opened.`);
    }
    const content = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      after.nlink !== 1 ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs
    ) {
      fail(`${label} changed while it was being read.`);
    }
    return content;
  } catch {
    fail(`${label} could not be read safely.`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function verifyPrivateCopy(path, expectedBytes, label) {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new Error(`${label} type changed`);
  }
  const content = readFileSync(path);
  const after = lstatSync(path);
  if (
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.nlink !== 1 ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs ||
    sha256(content) !== sha256(expectedBytes)
  ) {
    throw new Error(`${label} changed`);
  }
}

function createManifest() {
  validateDistDirectory();
  const releaseCommit = gitHead();
  const bundle = readRegularFile(BUNDLE_PATH, `The ${target} bundle`);
  const config = readRegularFile(
    CONFIG_PATH,
    `The ${target} Wrangler configuration`,
  );
  requireReleaseConfig(config, releaseCommit);
  if (existsSync(MANIFEST_PATH)) {
    const existing = lstatSync(MANIFEST_PATH);
    if (
      !existing.isFile() ||
      existing.isSymbolicLink() ||
      existing.nlink !== 1
    ) {
      fail(
        `The ${target} bundle manifest must be a regular, non-symlink, single-link file.`,
      );
    }
  }
  const manifest = {
    schemaVersion: 3,
    target,
    releaseCommit,
    bundlePath: BUNDLE_PATH,
    sha256: sha256(bundle),
    size: bundle.length,
    configPath: CONFIG_PATH,
    configSha256: sha256(config),
    configSize: config.length,
  };
  const temporaryManifest = `${MANIFEST_PATH}.tmp-${process.pid}`;
  let descriptor;
  try {
    descriptor = openSync(
      temporaryManifest,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryManifest, MANIFEST_PATH);
  } catch {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporaryManifest)) unlinkSync(temporaryManifest);
    fail(`The ${target} bundle manifest could not be written safely.`);
  }
  process.stdout.write(
    `Recorded ${target} bundle ${manifest.sha256} for ${manifest.releaseCommit}.\n`,
  );
}

function verifyManifest() {
  validateDistDirectory();
  const approvedRelease = process.env[releaseVariable];
  if (!approvedRelease || !/^[0-9a-f]{40}$/u.test(approvedRelease)) {
    fail(
      `${releaseVariable} must be the approved full 40-character lowercase release commit.`,
    );
  }
  if (gitHead() !== approvedRelease) {
    fail(`${releaseVariable} does not match the ${target} bundle checkout.`);
  }

  const manifestBytes = readRegularFile(
    MANIFEST_PATH,
    `The ${target} bundle manifest`,
  );
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    fail(`The ${target} bundle manifest is not valid JSON.`);
  }
  const expectedKeys = [
    "bundlePath",
    "configPath",
    "configSha256",
    "configSize",
    "releaseCommit",
    "schemaVersion",
    "sha256",
    "size",
    "target",
  ];
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    JSON.stringify(Object.keys(manifest).sort()) !==
      JSON.stringify(expectedKeys) ||
    manifest.schemaVersion !== 3 ||
    manifest.target !== target ||
    manifest.bundlePath !== BUNDLE_PATH ||
    manifest.configPath !== CONFIG_PATH ||
    !/^[0-9a-f]{40}$/u.test(manifest.releaseCommit ?? "") ||
    !/^[0-9a-f]{64}$/u.test(manifest.sha256 ?? "") ||
    !/^[0-9a-f]{64}$/u.test(manifest.configSha256 ?? "") ||
    !Number.isSafeInteger(manifest.size) ||
    manifest.size < 0 ||
    !Number.isSafeInteger(manifest.configSize) ||
    manifest.configSize < 0
  ) {
    fail(`The ${target} bundle manifest has an invalid schema.`);
  }
  if (manifest.releaseCommit !== approvedRelease) {
    fail(`The ${target} bundle manifest is not bound to ${releaseVariable}.`);
  }

  const bundle = readRegularFile(BUNDLE_PATH, `The ${target} bundle`);
  if (bundle.length !== manifest.size || sha256(bundle) !== manifest.sha256) {
    fail(`The ${target} bundle does not match its release manifest.`);
  }
  const config = readRegularFile(
    CONFIG_PATH,
    `The ${target} Wrangler configuration`,
  );
  if (
    config.length !== manifest.configSize ||
    sha256(config) !== manifest.configSha256
  ) {
    fail(
      `The ${target} Wrangler configuration does not match its release manifest.`,
    );
  }
  requireReleaseConfig(config, approvedRelease);
  process.stdout.write(
    `Verified ${target} bundle ${manifest.sha256} for ${approvedRelease}.\n`,
  );
  return { bundle, config, releaseCommit: approvedRelease };
}

function deployVerifiedBundle(bundle, config, releaseCommit, dryRun) {
  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), `connectwise-${target}-deploy-`),
  );
  const temporaryBundle = join(temporaryDirectory, "index.js");
  const temporaryEnvironment = join(temporaryDirectory, "empty.env");
  const emptyEnvironment = Buffer.alloc(0);
  // Keep the copied config beside the reviewed config so Wrangler preserves
  // relative-path resolution while consuming only manifest-bound bytes.
  const temporaryConfig = join(
    process.cwd(),
    `.wrangler.${target}-deploy-${process.pid}-${randomBytes(16).toString("hex")}.jsonc`,
  );
  let bundleWriteDescriptor;
  let environmentWriteDescriptor;
  let configWriteDescriptor;
  let result;
  try {
    bundleWriteDescriptor = openSync(
      temporaryBundle,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(bundleWriteDescriptor, bundle);
    fsyncSync(bundleWriteDescriptor);
    closeSync(bundleWriteDescriptor);
    bundleWriteDescriptor = undefined;

    environmentWriteDescriptor = openSync(
      temporaryEnvironment,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(environmentWriteDescriptor, emptyEnvironment);
    fsyncSync(environmentWriteDescriptor);
    closeSync(environmentWriteDescriptor);
    environmentWriteDescriptor = undefined;

    configWriteDescriptor = openSync(
      temporaryConfig,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(configWriteDescriptor, config);
    fsyncSync(configWriteDescriptor);
    closeSync(configWriteDescriptor);
    configWriteDescriptor = undefined;

    chmodSync(temporaryBundle, 0o400);
    chmodSync(temporaryEnvironment, 0o400);
    chmodSync(temporaryConfig, 0o400);
    chmodSync(temporaryDirectory, 0o500);

    const wrangler = join(process.cwd(), "node_modules", ".bin", "wrangler");
    const arguments_ = [
      "deploy",
      temporaryBundle,
      "--no-bundle",
      "--config",
      temporaryConfig,
    ];
    arguments_.push("--env", target === "staging" ? "staging" : "");
    arguments_.push(
      "--keep-vars",
      "--strict",
      "--env-file",
      temporaryEnvironment,
      "--tag",
      releaseCommit,
      "--message",
      `ConnectwiseMCP ${target} release ${releaseCommit}`,
    );
    if (dryRun) arguments_.push("--dry-run");
    result = spawnSync(wrangler, arguments_, {
      env: process.env,
      stdio: "inherit",
    });

    try {
      verifyPrivateCopy(temporaryBundle, bundle, "private bundle");
      verifyPrivateCopy(
        temporaryEnvironment,
        emptyEnvironment,
        "private environment",
      );
      verifyPrivateCopy(temporaryConfig, config, "private configuration");
    } catch (error) {
      result = { status: 1, error };
    }
  } finally {
    if (bundleWriteDescriptor !== undefined) closeSync(bundleWriteDescriptor);
    if (environmentWriteDescriptor !== undefined)
      closeSync(environmentWriteDescriptor);
    if (configWriteDescriptor !== undefined) closeSync(configWriteDescriptor);
    try {
      const directoryStat = lstatSync(temporaryDirectory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
        throw new Error(`Private ${target} directory type changed`);
      }
      chmodSync(temporaryDirectory, 0o700);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    for (const path of [
      temporaryBundle,
      temporaryEnvironment,
      temporaryConfig,
    ]) {
      try {
        unlinkSync(path);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    try {
      rmdirSync(temporaryDirectory);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  if (result?.error || result?.status !== 0) {
    fail(
      dryRun
        ? `Wrangler could not consume the verified ${target} bundle.`
        : `Wrangler did not deploy the verified ${target} bundle.`,
    );
  }
}

if (action === "create") createManifest();
else {
  const verified = verifyManifest();
  if (action === "deploy" || action === "dry-run") {
    deployVerifiedBundle(
      verified.bundle,
      verified.config,
      verified.releaseCommit,
      action === "dry-run",
    );
  }
}
