import { randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

const [, , sbomPath, lockPath] = process.argv;
if (process.argv.length !== 4) {
  process.stderr.write(
    "Usage: node scripts/normalize-v2-sbom.mjs <sbom-path> <package-lock-path>\n",
  );
  process.exit(1);
}

class NormalizationError extends Error {}

function fail(message) {
  throw new NormalizationError(message);
}

function identity(stat) {
  return {
    ctimeMs: stat.ctimeMs,
    dev: stat.dev,
    ino: stat.ino,
    mtimeMs: stat.mtimeMs,
    nlink: stat.nlink,
    size: stat.size,
    type: stat.mode & constants.S_IFMT,
  };
}

function sameIdentity(left, right) {
  return Object.keys(left).every((key) => left[key] === right[key]);
}

function closeQuietly(descriptor) {
  try {
    closeSync(descriptor);
  } catch {}
}

function openBoundedRegularFile(path, limit, label) {
  let descriptor;
  try {
    const before = lstatSync(path);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      before.size > limit
    ) {
      fail(`${label} must be a bounded regular, non-symlink, single-link file`);
    }
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.size > limit ||
      !sameIdentity(identity(before), identity(opened))
    ) {
      fail(`${label} changed while it was opened`);
    }
    const bytes = readFileSync(descriptor);
    if (!sameIdentity(identity(opened), identity(fstatSync(descriptor)))) {
      fail(`${label} changed while it was read`);
    }
    return { bytes, descriptor, identity: identity(opened) };
  } catch (error) {
    if (descriptor !== undefined) closeQuietly(descriptor);
    if (error instanceof NormalizationError) throw error;
    fail(`${label} could not be read safely`);
  }
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(`${label} is not valid JSON`);
  }
}

let lockFile;
let sbomFile;
let temporaryDescriptor;
let temporaryPath;
try {
  lockFile = openBoundedRegularFile(lockPath, 64 * 1024 * 1024, "package lock");
  sbomFile = openBoundedRegularFile(
    sbomPath,
    64 * 1024 * 1024,
    "CycloneDX SBOM",
  );
  const lock = parseJson(lockFile.bytes, "package lock");
  const sbom = parseJson(sbomFile.bytes, "CycloneDX SBOM");
  if (
    lock === null ||
    typeof lock !== "object" ||
    Array.isArray(lock) ||
    typeof lock.name !== "string" ||
    lock.name.length === 0 ||
    sbom === null ||
    typeof sbom !== "object" ||
    Array.isArray(sbom) ||
    sbom.metadata === null ||
    typeof sbom.metadata !== "object" ||
    Array.isArray(sbom.metadata) ||
    sbom.metadata.component === null ||
    typeof sbom.metadata.component !== "object" ||
    Array.isArray(sbom.metadata.component)
  ) {
    fail("the package lock or CycloneDX root metadata is invalid");
  }

  sbom.metadata.component.name = lock.name;
  sbom.serialNumber = `urn:uuid:${randomUUID()}`;
  const output = `${JSON.stringify(sbom, null, 2)}\n`;
  temporaryPath = `${sbomPath}.tmp-${process.pid}-${randomBytes(16).toString("hex")}`;
  temporaryDescriptor = openSync(
    temporaryPath,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  writeFileSync(temporaryDescriptor, output, "utf8");
  fsyncSync(temporaryDescriptor);
  closeSync(temporaryDescriptor);
  temporaryDescriptor = undefined;

  if (
    !sameIdentity(
      lockFile.identity,
      identity(fstatSync(lockFile.descriptor)),
    ) ||
    !sameIdentity(lockFile.identity, identity(lstatSync(lockPath)))
  ) {
    fail("the package lock changed before SBOM replacement");
  }
  if (
    !sameIdentity(
      sbomFile.identity,
      identity(fstatSync(sbomFile.descriptor)),
    ) ||
    !sameIdentity(sbomFile.identity, identity(lstatSync(sbomPath)))
  ) {
    fail("the CycloneDX SBOM changed before replacement");
  }
  renameSync(temporaryPath, sbomPath);
  temporaryPath = undefined;
} catch (error) {
  const message =
    error instanceof NormalizationError
      ? error.message
      : "the CycloneDX SBOM could not be replaced safely";
  process.stderr.write(`V2 SBOM normalization failed: ${message}\n`);
  process.exitCode = 1;
} finally {
  if (temporaryDescriptor !== undefined) closeQuietly(temporaryDescriptor);
  if (temporaryPath !== undefined) {
    try {
      unlinkSync(temporaryPath);
    } catch {}
  }
  if (sbomFile?.descriptor !== undefined) closeQuietly(sbomFile.descriptor);
  if (lockFile?.descriptor !== undefined) closeQuietly(lockFile.descriptor);
}
