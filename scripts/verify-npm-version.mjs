import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const expectedNpmVersion = "11.6.1";
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const manifestUrl = new URL("../package.json", import.meta.url);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

if (process.argv.length !== 2) {
  fail("The npm toolchain verifier does not accept arguments.");
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestUrl, "utf8"));
} catch {
  fail("The package manifest is missing or malformed.");
}

const policy = manifest.devEngines?.packageManager;
if (
  manifest.packageManager !== `npm@${expectedNpmVersion}` ||
  policy?.name !== "npm" ||
  policy?.version !== expectedNpmVersion ||
  policy?.onFail !== "error"
) {
  fail("The package manifest does not enforce the reviewed npm version.");
}

const npm = spawnSync("npm", ["--version"], {
  cwd: repositoryRoot,
  encoding: "utf8",
  shell: false,
  timeout: 10_000,
  maxBuffer: 1024,
});
if (
  npm.error ||
  npm.signal ||
  npm.status !== 0 ||
  npm.stderr !== "" ||
  npm.stdout.trim() !== expectedNpmVersion
) {
  fail(`npm ${expectedNpmVersion} is required before dependency operations.`);
}

process.stdout.write(`Verified npm ${expectedNpmVersion}.\n`);
