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
if (
  action !== "create" &&
  action !== "verify" &&
  action !== "deploy" &&
  action !== "dry-run"
) {
  process.stderr.write(
    "Usage: node scripts/staging-bundle-integrity.mjs <create|verify|deploy|dry-run>\n",
  );
  process.exit(1);
}

const DIST_PATH = "dist";
const BUNDLE_PATH = "dist/index.js";
const CONFIG_PATH = "wrangler.jsonc";
const MANIFEST_PATH = "dist/staging-bundle-manifest.json";
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
  if (result.status !== 0) fail("Unable to resolve the staging bundle commit.");
  const head = result.stdout.trim();
  if (!/^[0-9a-f]{40}$/u.test(head)) {
    fail("The staging bundle commit is not a canonical Git object ID.");
  }
  return head;
}

function validateDistDirectory() {
  let stat;
  try {
    stat = lstatSync(DIST_PATH);
  } catch {
    fail("The staging bundle directory is missing.");
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail("The staging bundle directory must be a real directory.");
  }
  if (realpathSync(DIST_PATH) !== resolve(DIST_PATH)) {
    fail("The staging bundle directory must remain inside the checkout.");
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
  const bundle = readRegularFile(BUNDLE_PATH, "The staging bundle");
  const config = readRegularFile(
    CONFIG_PATH,
    "The staging Wrangler configuration",
  );
  if (existsSync(MANIFEST_PATH)) {
    const existing = lstatSync(MANIFEST_PATH);
    if (
      !existing.isFile() ||
      existing.isSymbolicLink() ||
      existing.nlink !== 1
    ) {
      fail(
        "The staging bundle manifest must be a regular, non-symlink, single-link file.",
      );
    }
  }
  const manifest = {
    schemaVersion: 2,
    releaseCommit: gitHead(),
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
    fail("The staging bundle manifest could not be written safely.");
  }
  process.stdout.write(
    `Recorded staging bundle ${manifest.sha256} for ${manifest.releaseCommit}.\n`,
  );
}

function verifyManifest() {
  validateDistDirectory();
  const approvedRelease = process.env.STAGING_RELEASE_SHA;
  if (!approvedRelease || !/^[0-9a-f]{40}$/u.test(approvedRelease)) {
    fail(
      "STAGING_RELEASE_SHA must be the approved full 40-character lowercase release commit.",
    );
  }
  if (gitHead() !== approvedRelease) {
    fail("STAGING_RELEASE_SHA does not match the staging bundle checkout.");
  }

  const manifestBytes = readRegularFile(
    MANIFEST_PATH,
    "The staging bundle manifest",
  );
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    fail("The staging bundle manifest is not valid JSON.");
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
  ];
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    JSON.stringify(Object.keys(manifest).sort()) !==
      JSON.stringify(expectedKeys) ||
    manifest.schemaVersion !== 2 ||
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
    fail("The staging bundle manifest has an invalid schema.");
  }
  if (manifest.releaseCommit !== approvedRelease) {
    fail("The staging bundle manifest is not bound to STAGING_RELEASE_SHA.");
  }

  const bundle = readRegularFile(BUNDLE_PATH, "The staging bundle");
  if (bundle.length !== manifest.size || sha256(bundle) !== manifest.sha256) {
    fail("The staging bundle does not match its release manifest.");
  }
  const config = readRegularFile(
    CONFIG_PATH,
    "The staging Wrangler configuration",
  );
  if (
    config.length !== manifest.configSize ||
    sha256(config) !== manifest.configSha256
  ) {
    fail(
      "The staging Wrangler configuration does not match its release manifest.",
    );
  }
  process.stdout.write(
    `Verified staging bundle ${manifest.sha256} for ${approvedRelease}.\n`,
  );
  return { bundle, config };
}

function deployVerifiedBundle(bundle, config, dryRun) {
  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), "connectwise-staging-deploy-"),
  );
  const temporaryBundle = join(temporaryDirectory, "index.js");
  // Keep the copied config beside the reviewed config so Wrangler preserves
  // relative-path resolution while consuming only manifest-bound bytes.
  const temporaryConfig = join(
    process.cwd(),
    `.wrangler.staging-deploy-${process.pid}-${randomBytes(16).toString("hex")}.jsonc`,
  );
  let bundleWriteDescriptor;
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
    chmodSync(temporaryConfig, 0o400);
    chmodSync(temporaryDirectory, 0o500);

    const wrangler = join(process.cwd(), "node_modules", ".bin", "wrangler");
    const arguments_ = [
      "deploy",
      temporaryBundle,
      "--no-bundle",
      "--config",
      temporaryConfig,
      "--env",
      "staging",
      "--keep-vars",
      "--strict",
    ];
    if (dryRun) arguments_.push("--dry-run");
    result = spawnSync(wrangler, arguments_, {
      env: process.env,
      stdio: "inherit",
    });

    try {
      verifyPrivateCopy(temporaryBundle, bundle, "private bundle");
      verifyPrivateCopy(temporaryConfig, config, "private configuration");
    } catch (error) {
      result = { status: 1, error };
    }
  } finally {
    if (bundleWriteDescriptor !== undefined) closeSync(bundleWriteDescriptor);
    if (configWriteDescriptor !== undefined) closeSync(configWriteDescriptor);
    try {
      const directoryStat = lstatSync(temporaryDirectory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
        throw new Error("Private staging directory type changed");
      }
      chmodSync(temporaryDirectory, 0o700);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    for (const path of [temporaryBundle, temporaryConfig]) {
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
        ? "Wrangler could not consume the verified staging bundle."
        : "Wrangler did not deploy the verified staging bundle.",
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
      action === "dry-run",
    );
  }
}
