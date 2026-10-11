import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join, posix } from "node:path";

const [, , evidenceDirectory, target, expectedRelease] = process.argv;
if (
  process.argv.length !== 5 ||
  (target !== "staging" && target !== "production") ||
  !/^[0-9a-f]{40}$/u.test(expectedRelease ?? "")
) {
  process.stderr.write(
    "Usage: node scripts/verify-v2-release-evidence.mjs <evidence-directory> <staging|production> <full-lowercase-release-sha>\n",
  );
  process.exit(1);
}

const manifestName = `${target}-bundle-manifest.json`;
const inventoryName = `${target}-runtime-inventory.json`;
const sbomName = `connectwise-v2-${target}.cdx.json`;
const expectedFiles = [
  sbomName,
  "index.js",
  "package-lock.json",
  manifestName,
  inventoryName,
  "wrangler.jsonc",
].sort();
const limits = new Map([
  ["index.js", 1024 * 1024 * 1024],
  ["package-lock.json", 64 * 1024 * 1024],
  [manifestName, 64 * 1024],
  [inventoryName, 64 * 1024 * 1024],
  ["wrangler.jsonc", 4 * 1024 * 1024],
  [sbomName, 64 * 1024 * 1024],
]);

function fail(message) {
  process.stderr.write(`V2 release evidence verification failed: ${message}\n`);
  process.exit(1);
}

function exactKeys(value, expected) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...expected].sort())
  );
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
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

let directoryStat;
try {
  directoryStat = lstatSync(evidenceDirectory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    fail("the evidence path must be a real directory");
  }
} catch (error) {
  if (error?.message?.startsWith("V2 release evidence")) throw error;
  fail("the evidence directory could not be opened safely");
}

let names;
try {
  names = readdirSync(evidenceDirectory).sort();
} catch {
  fail("the evidence directory could not be listed");
}
if (JSON.stringify(names) !== JSON.stringify(expectedFiles)) {
  fail("the evidence directory does not contain the exact expected file set");
}

const files = new Map();
const fileDescriptors = new Map();
const fileIdentities = new Map();
for (const name of expectedFiles) {
  const path = join(evidenceDirectory, name);
  let descriptor;
  try {
    const before = lstatSync(path);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      before.size > limits.get(name)
    ) {
      fail(`${name} must be a bounded regular, non-symlink, single-link file`);
    }
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.ctimeMs !== before.ctimeMs ||
      opened.mtimeMs !== before.mtimeMs
    ) {
      fail(`${name} changed while it was opened`);
    }
    fileIdentities.set(name, identity(opened));
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (!sameIdentity(identity(opened), identity(after))) {
      fail(`${name} changed while it was read`);
    }
    files.set(name, bytes);
    fileDescriptors.set(name, descriptor);
    descriptor = undefined;
  } catch (error) {
    if (error?.message?.startsWith("V2 release evidence")) throw error;
    fail(`${name} could not be read safely`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
if (
  JSON.stringify(readdirSync(evidenceDirectory).sort()) !==
  JSON.stringify(names)
) {
  fail("the evidence file set changed while it was read");
}

function parseJson(name) {
  try {
    return JSON.parse(files.get(name).toString("utf8"));
  } catch {
    fail(`${name} is not valid JSON`);
  }
}

const manifest = parseJson(manifestName);
const manifestKeys = [
  "bundlePath",
  "configPath",
  "configSha256",
  "configSize",
  "lockPath",
  "lockSha256",
  "lockSize",
  "releaseCommit",
  "runtimeFileCount",
  "runtimeInventoryPath",
  "runtimeInventorySha256",
  "runtimeInventorySize",
  "runtimePath",
  "runtimeSha256",
  "schemaVersion",
  "sha256",
  "size",
  "target",
];
const hashFields = [
  "sha256",
  "configSha256",
  "lockSha256",
  "runtimeSha256",
  "runtimeInventorySha256",
];
const sizeFields = ["size", "configSize", "lockSize", "runtimeInventorySize"];
if (
  !exactKeys(manifest, manifestKeys) ||
  manifest.schemaVersion !== 5 ||
  manifest.target !== target ||
  manifest.releaseCommit !== expectedRelease ||
  manifest.bundlePath !== "dist/index.js" ||
  manifest.configPath !== "wrangler.jsonc" ||
  manifest.lockPath !== "package-lock.json" ||
  manifest.runtimePath !== "node_modules" ||
  manifest.runtimeInventoryPath !== `dist/${inventoryName}` ||
  hashFields.some((field) => !/^[0-9a-f]{64}$/u.test(manifest[field] ?? "")) ||
  sizeFields.some(
    (field) => !Number.isSafeInteger(manifest[field]) || manifest[field] < 0,
  ) ||
  manifest.runtimeInventorySize < 1 ||
  !Number.isSafeInteger(manifest.runtimeFileCount) ||
  manifest.runtimeFileCount < 1
) {
  fail(`${manifestName} has an invalid strict schema or release binding`);
}
if (
  !files
    .get(manifestName)
    .equals(Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`))
) {
  fail(`${manifestName} is not canonically encoded`);
}

for (const [name, sizeField, hashField] of [
  ["index.js", "size", "sha256"],
  ["wrangler.jsonc", "configSize", "configSha256"],
  ["package-lock.json", "lockSize", "lockSha256"],
  [inventoryName, "runtimeInventorySize", "runtimeInventorySha256"],
]) {
  const bytes = files.get(name);
  if (
    bytes.length !== manifest[sizeField] ||
    sha256(bytes) !== manifest[hashField]
  ) {
    fail(`${name} does not match its manifest size and SHA-256 binding`);
  }
}

const inventory = parseJson(inventoryName);
if (
  !exactKeys(inventory, [
    "records",
    "runtimePath",
    "schemaVersion",
    "target",
  ]) ||
  inventory.schemaVersion !== 1 ||
  inventory.target !== target ||
  inventory.runtimePath !== "node_modules" ||
  !Array.isArray(inventory.records) ||
  inventory.records.length < 3 ||
  inventory.records.length > 1_000_000 ||
  !files
    .get(inventoryName)
    .equals(Buffer.from(`${JSON.stringify(inventory, null, 2)}\n`))
) {
  fail(`${inventoryName} has an invalid bounded canonical schema`);
}

const digest = createHash("sha256");
let fileCount = 0;
const paths = new Set();
const directories = new Set();
const links = new Map();
const updateField = (value) => {
  const bytes = Buffer.from(String(value));
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  digest.update(length);
  digest.update(bytes);
};
const validPath = (path, root = false) => {
  if (
    typeof path !== "string" ||
    Buffer.byteLength(path) > 4096 ||
    path.includes("\0")
  ) {
    return false;
  }
  if (root && path === "") return true;
  return (
    path !== "" &&
    !path.startsWith("/") &&
    !path.endsWith("/") &&
    path
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
};
for (const [index, record] of inventory.records.entries()) {
  if (!Array.isArray(record))
    fail(`${inventoryName} contains a malformed record`);
  const [kind, path] = record;
  const isLast = index === inventory.records.length - 1;
  if (isLast) {
    if (
      record.length !== 3 ||
      kind !== "summary" ||
      record[1] !== index ||
      record[2] !== fileCount
    ) {
      fail(`${inventoryName} has an invalid summary record`);
    }
  } else {
    if (!validPath(path, index === 0) || paths.has(path)) {
      fail(`${inventoryName} contains an invalid or duplicate runtime path`);
    }
    const parent = path.includes("/")
      ? path.slice(0, path.lastIndexOf("/"))
      : "";
    if (index !== 0 && !directories.has(parent)) {
      fail(
        `${inventoryName} contains a path without an earlier parent directory`,
      );
    }
    paths.add(path);
    if (kind === "directory") {
      if (record.length !== 2 || (index === 0 && path !== "")) {
        fail(`${inventoryName} contains a malformed directory record`);
      }
      directories.add(path);
    } else if (kind === "file") {
      if (
        record.length !== 5 ||
        !Number.isSafeInteger(record[2]) ||
        record[2] < 0 ||
        record[2] > 0o777 ||
        !Number.isSafeInteger(record[3]) ||
        record[3] < 0 ||
        !/^[0-9a-f]{64}$/u.test(record[4] ?? "")
      ) {
        fail(`${inventoryName} contains a malformed file record`);
      }
      fileCount += 1;
    } else if (kind === "link") {
      if (
        record.length !== 3 ||
        typeof record[2] !== "string" ||
        record[2].length === 0 ||
        Buffer.byteLength(record[2]) > 4096 ||
        record[2].includes("\0") ||
        posix.isAbsolute(record[2])
      ) {
        fail(`${inventoryName} contains a malformed relative symlink record`);
      }
      links.set(path, record[2]);
    } else {
      fail(`${inventoryName} contains an unsupported record type`);
    }
  }
  updateField(record.length);
  for (const field of record) updateField(field);
}

function resolveLink(linkPath, target) {
  const parent = posix.dirname(linkPath) === "." ? "" : posix.dirname(linkPath);
  const resolvedParts = parent === "" ? [] : parent.split("/");
  const pendingParts = target.split("/");
  const seenStates = new Set();
  let resolutionSteps = 0;

  while (pendingParts.length > 0) {
    resolutionSteps += 1;
    if (resolutionSteps > 100_000 || pendingParts.length > 8_192) {
      fail(`${inventoryName} contains an excessively complex symlink chain`);
    }
    const state = sha256(
      Buffer.from(JSON.stringify([resolvedParts, pendingParts])),
    );
    if (seenStates.has(state)) {
      fail(`${inventoryName} contains a symlink cycle`);
    }
    seenStates.add(state);

    const part = pendingParts.shift();
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (resolvedParts.length === 0) {
        fail(`${inventoryName} contains a symlink that escapes the runtime`);
      }
      resolvedParts.pop();
      continue;
    }

    resolvedParts.push(part);
    const candidate = resolvedParts.join("/");
    const nestedTarget = links.get(candidate);
    if (nestedTarget !== undefined) {
      resolvedParts.pop();
      pendingParts.unshift(...nestedTarget.split("/"));
    } else if (pendingParts.length > 0 && !directories.has(candidate)) {
      fail(
        `${inventoryName} contains a symlink path that traverses a non-directory`,
      );
    }
  }

  const resolved = resolvedParts.join("/");
  if (!paths.has(resolved)) {
    fail(`${inventoryName} contains a symlink with a missing target`);
  }
}

for (const [linkPath, target] of links) resolveLink(linkPath, target);
if (
  fileCount !== manifest.runtimeFileCount ||
  digest.digest("hex") !== manifest.runtimeSha256
) {
  fail(
    `${inventoryName} does not reproduce the manifest runtime digest and count`,
  );
}

const lock = parseJson("package-lock.json");
if (
  lock === null ||
  typeof lock !== "object" ||
  Array.isArray(lock) ||
  typeof lock.name !== "string" ||
  lock.name.length === 0 ||
  typeof lock.version !== "string" ||
  lock.version.length === 0 ||
  lock.lockfileVersion !== 3 ||
  lock.packages === null ||
  typeof lock.packages !== "object" ||
  Array.isArray(lock.packages) ||
  lock.packages[""] === null ||
  typeof lock.packages[""] !== "object" ||
  Array.isArray(lock.packages[""]) ||
  lock.packages[""].name !== lock.name ||
  lock.packages[""].version !== lock.version
) {
  fail("package-lock.json has an invalid root or packages structure");
}

const lockPackages = new Set();
const requiredLockPackages = new Set();
const lockPackageRecords = new Map();
for (const [packagePath, packageRecord] of Object.entries(lock.packages)) {
  if (packagePath === "") {
    lockPackageRecords.set(packagePath, {
      identity: JSON.stringify([lock.name, lock.version]),
      record: packageRecord,
    });
    continue;
  }
  if (
    !/^(?:node_modules\/(?:@[^/]+\/)?[^/]+)(?:\/node_modules\/(?:@[^/]+\/)?[^/]+)*$/u.test(
      packagePath,
    ) ||
    packageRecord === null ||
    typeof packageRecord !== "object" ||
    Array.isArray(packageRecord) ||
    typeof packageRecord.version !== "string" ||
    packageRecord.version.length === 0
  ) {
    fail("package-lock.json contains an invalid package record");
  }
  const packageName =
    packageRecord.name ??
    packagePath.slice(packagePath.lastIndexOf("node_modules/") + 13);
  if (typeof packageName !== "string" || packageName.length === 0) {
    fail("package-lock.json contains a package without a valid name");
  }
  const packageIdentity = JSON.stringify([packageName, packageRecord.version]);
  lockPackages.add(packageIdentity);
  lockPackageRecords.set(packagePath, {
    identity: packageIdentity,
    record: packageRecord,
  });
  if (packageRecord.optional !== true)
    requiredLockPackages.add(packageIdentity);
}

const sbom = parseJson(sbomName);
if (
  !files
    .get(sbomName)
    .equals(Buffer.from(`${JSON.stringify(sbom, null, 2)}\n`)) ||
  !exactKeys(sbom, [
    "$schema",
    "bomFormat",
    "components",
    "dependencies",
    "metadata",
    "serialNumber",
    "specVersion",
    "version",
  ]) ||
  sbom.$schema !==
    `http://cyclonedx.org/schema/bom-${sbom.specVersion}.schema.json` ||
  sbom.bomFormat !== "CycloneDX" ||
  !/^1\.[0-9]+$/u.test(sbom.specVersion ?? "") ||
  !/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
    sbom.serialNumber ?? "",
  ) ||
  !Number.isSafeInteger(sbom.version) ||
  sbom.version < 1 ||
  sbom.metadata === null ||
  typeof sbom.metadata !== "object" ||
  Array.isArray(sbom.metadata) ||
  !Array.isArray(sbom.components) ||
  !Array.isArray(sbom.dependencies) ||
  sbom.components.some(
    (component) =>
      component === null ||
      typeof component !== "object" ||
      Array.isArray(component) ||
      typeof component["bom-ref"] !== "string" ||
      component["bom-ref"].length === 0 ||
      typeof component.type !== "string" ||
      typeof component.name !== "string" ||
      component.name.length === 0 ||
      typeof component.version !== "string" ||
      component.version.length === 0,
  )
) {
  fail(`${sbomName} does not have the required strict CycloneDX structure`);
}

const rootComponent = sbom.metadata.component;
const expectedRootPurl = `pkg:npm/${encodeURIComponent(lock.name).replaceAll("%2F", "/")}@${encodeURIComponent(lock.version)}`;
if (
  rootComponent === null ||
  typeof rootComponent !== "object" ||
  Array.isArray(rootComponent) ||
  rootComponent["bom-ref"] !== `${lock.name}@${lock.version}` ||
  rootComponent.name !== lock.name ||
  rootComponent.version !== lock.version ||
  rootComponent.purl !== expectedRootPurl
) {
  fail(`${sbomName} root metadata does not match package-lock.json`);
}

const componentIdentities = new Set();
const componentReferences = new Map([
  [JSON.stringify([lock.name, lock.version]), rootComponent["bom-ref"]],
]);
const references = new Set([rootComponent["bom-ref"]]);
for (const component of sbom.components) {
  const componentIdentity = JSON.stringify([component.name, component.version]);
  if (
    componentIdentities.has(componentIdentity) ||
    !lockPackages.has(componentIdentity)
  ) {
    fail(`${sbomName} contains a duplicate or unrelated component`);
  }
  if (references.has(component["bom-ref"])) {
    fail(`${sbomName} contains a duplicate component reference`);
  }
  componentIdentities.add(componentIdentity);
  componentReferences.set(componentIdentity, component["bom-ref"]);
  references.add(component["bom-ref"]);
}
if (
  [...requiredLockPackages].some(
    (identity) => !componentIdentities.has(identity),
  )
) {
  fail(`${sbomName} omits a non-optional package-lock.json package`);
}

const expectedDependencies = new Map(
  [...references].map((reference) => [reference, new Set()]),
);
function parentPackagePath(packagePath) {
  const marker = packagePath.lastIndexOf("/node_modules/");
  return marker === -1 ? "" : packagePath.slice(0, marker);
}
function resolveLockedDependency(packagePath, dependencyName) {
  let parent = packagePath;
  while (true) {
    const candidate = parent
      ? `${parent}/node_modules/${dependencyName}`
      : `node_modules/${dependencyName}`;
    if (lockPackageRecords.has(candidate))
      return lockPackageRecords.get(candidate);
    if (parent === "") return undefined;
    parent = parentPackagePath(parent);
  }
}
for (const [
  packagePath,
  { identity: sourceIdentity, record },
] of lockPackageRecords) {
  const sourceReference = componentReferences.get(sourceIdentity);
  if (sourceReference === undefined) continue;
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const declared = record[field];
    if (declared === undefined) continue;
    if (
      declared === null ||
      typeof declared !== "object" ||
      Array.isArray(declared) ||
      Object.entries(declared).some(
        ([name, requirement]) =>
          name.length === 0 || typeof requirement !== "string",
      )
    ) {
      fail(`package-lock.json contains an invalid ${field} map`);
    }
    for (const dependencyName of Object.keys(declared)) {
      const targetRecord = resolveLockedDependency(packagePath, dependencyName);
      if (targetRecord === undefined) continue;
      const targetReference = componentReferences.get(targetRecord.identity);
      if (targetReference !== undefined)
        expectedDependencies.get(sourceReference).add(targetReference);
    }
  }
}

const dependencyReferences = new Set();
for (const dependency of sbom.dependencies) {
  if (
    dependency === null ||
    typeof dependency !== "object" ||
    Array.isArray(dependency) ||
    typeof dependency.ref !== "string" ||
    !references.has(dependency.ref) ||
    dependencyReferences.has(dependency.ref) ||
    !Array.isArray(dependency.dependsOn) ||
    new Set(dependency.dependsOn).size !== dependency.dependsOn.length ||
    dependency.dependsOn.some(
      (reference) =>
        typeof reference !== "string" || !references.has(reference),
    )
  ) {
    fail(
      `${sbomName} contains invalid, duplicate, or dangling dependency references`,
    );
  }
  const expected = expectedDependencies.get(dependency.ref);
  if (
    dependency.dependsOn.length !== expected.size ||
    dependency.dependsOn.some((reference) => !expected.has(reference))
  ) {
    fail(`${sbomName} dependency graph does not match package-lock.json`);
  }
  dependencyReferences.add(dependency.ref);
}
if (
  dependencyReferences.size !== references.size ||
  [...references].some((reference) => !dependencyReferences.has(reference))
) {
  fail(`${sbomName} omits dependency records for declared components`);
}

try {
  if (
    !sameIdentity(
      identity(directoryStat),
      identity(lstatSync(evidenceDirectory)),
    )
  ) {
    fail("the evidence directory changed during verification");
  }
  for (const name of expectedFiles) {
    if (
      !sameIdentity(
        fileIdentities.get(name),
        identity(fstatSync(fileDescriptors.get(name))),
      ) ||
      !sameIdentity(
        fileIdentities.get(name),
        identity(lstatSync(join(evidenceDirectory, name))),
      )
    ) {
      fail(`${name} changed during verification`);
    }
  }
  if (
    JSON.stringify(readdirSync(evidenceDirectory).sort()) !==
    JSON.stringify(names)
  ) {
    fail("the evidence file set changed during verification");
  }
} catch (error) {
  if (error?.message?.startsWith("V2 release evidence")) throw error;
  fail("the evidence directory could not be revalidated safely");
}
for (const descriptor of fileDescriptors.values()) closeSync(descriptor);

process.stdout.write(
  `Verified ${target} V2 release evidence for ${expectedRelease}.\n`,
);
