import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
} from "node:fs";

const target = process.argv[2] ?? "staging";
if (
  process.argv.length > 3 ||
  (target !== "staging" && target !== "production")
) {
  process.stderr.write(
    "Usage: node scripts/verify-staging-release.mjs [staging|production]\n",
  );
  process.exit(1);
}

const releaseName = target;
const releaseVariable =
  target === "production" ? "PRODUCTION_RELEASE_SHA" : "STAGING_RELEASE_SHA";
const approvedRelease = process.env[releaseVariable];
if (!approvedRelease || !/^[0-9a-f]{40}$/u.test(approvedRelease)) {
  process.stderr.write(
    `${releaseVariable} must be the approved full 40-character lowercase release commit.\n`,
  );
  process.exit(1);
}

const CANONICAL_REPOSITORY_URL =
  "https://github.com/luckyludev/ConnectwiseMCP.git";

const gitEnvironment = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  ),
  GIT_NO_REPLACE_OBJECTS: "1",
};

function git(args, failureMessage) {
  const result = spawnSync(
    "git",
    ["-c", "core.useReplaceRefs=false", "-c", "core.fsmonitor=false", ...args],
    {
      encoding: "utf8",
      env: gitEnvironment,
    },
  );
  if (result.status !== 0) {
    process.stderr.write(`${failureMessage}\n`);
    process.exit(1);
  }
  return result.stdout;
}

function gitBytes(args, failureMessage) {
  const result = spawnSync(
    "git",
    ["-c", "core.useReplaceRefs=false", "-c", "core.fsmonitor=false", ...args],
    { env: gitEnvironment },
  );
  if (result.status !== 0) {
    process.stderr.write(`${failureMessage}\n`);
    process.exit(1);
  }
  return result.stdout;
}

const repositoryRoot = git(
  ["rev-parse", "--show-toplevel"],
  `Unable to resolve the ${releaseName} release worktree.`,
).trim();
if (realpathSync(repositoryRoot) !== realpathSync(process.cwd())) {
  process.stderr.write(
    `The ${releaseName} release guard must run from the repository root.\n`,
  );
  process.exit(1);
}

const implicitWranglerEnvironmentFiles = [
  ".env",
  ".env.local",
  `.env.${target}`,
  `.env.${target}.local`,
];
if (implicitWranglerEnvironmentFiles.some((path) => existsSync(path))) {
  process.stderr.write(
    `Implicit Wrangler environment files are not allowed in the ${releaseName} release checkout.\n`,
  );
  process.exit(1);
}

const urlRewriteRules = spawnSync(
  "git",
  [
    "-c",
    "core.useReplaceRefs=false",
    "-c",
    "core.fsmonitor=false",
    "config",
    "--get-regexp",
    "^url\\..*\\.insteadOf$",
  ],
  {
    encoding: "utf8",
    env: gitEnvironment,
  },
);
if (urlRewriteRules.status === 0) {
  process.stderr.write(
    `Git URL rewrite rules are not allowed for ${releaseName} release verification.\n`,
  );
  process.exit(1);
}
if (urlRewriteRules.status !== 1) {
  process.stderr.write("Unable to inspect Git URL rewrite rules.\n");
  process.exit(1);
}

const graftsPath = git(
  ["rev-parse", "--git-path", "info/grafts"],
  "Unable to inspect legacy Git graft metadata.",
).trim();
if (existsSync(graftsPath)) {
  process.stderr.write(
    `Legacy Git graft metadata is not allowed for ${releaseName} release verification.\n`,
  );
  process.exit(1);
}

const head = git(
  ["rev-parse", "--verify", "HEAD^{commit}"],
  `Unable to resolve the ${releaseName} release commit.`,
).trim();
if (head !== approvedRelease) {
  process.stderr.write(
    `${releaseVariable} does not match the checked-out ${releaseName} release commit.\n`,
  );
  process.exit(1);
}

const originUrl = git(
  ["config", "--get", "remote.origin.url"],
  "Unable to resolve the canonical origin fetch URL.",
).trim();
if (originUrl !== CANONICAL_REPOSITORY_URL) {
  process.stderr.write(
    "The origin fetch URL does not match the canonical repository.\n",
  );
  process.exit(1);
}
git(
  [
    "fetch",
    "--quiet",
    "--no-tags",
    "--force",
    CANONICAL_REPOSITORY_URL,
    "+refs/heads/main:refs/remotes/origin/main",
  ],
  "Unable to fetch the canonical origin/main review boundary.",
);
const reviewedMain = git(
  ["rev-parse", "--verify", "refs/remotes/origin/main^{commit}"],
  "Unable to resolve the fetched origin/main review boundary.",
).trim();
const reviewBoundary = spawnSync(
  "git",
  [
    "-c",
    "core.useReplaceRefs=false",
    "-c",
    "core.fsmonitor=false",
    "merge-base",
    "--is-ancestor",
    head,
    reviewedMain,
  ],
  {
    encoding: "utf8",
    env: gitEnvironment,
  },
);
if (reviewBoundary.status !== 0) {
  process.stderr.write(
    reviewBoundary.status === 1
      ? `The ${releaseName} release commit is not contained in fetched origin/main.\n`
      : `Unable to verify the ${releaseName} release against fetched origin/main.\n`,
  );
  process.exit(1);
}

git(
  ["diff-index", "--cached", "--quiet", head, "--"],
  `The ${releaseName} release index must match the reviewed commit.`,
);

function blobObjectId(content) {
  const header = Buffer.from(`blob ${content.length}\0`, "utf8");
  return createHash("sha1").update(header).update(content).digest("hex");
}

const stagedEntries = gitBytes(
  ["ls-files", "--stage", "-z"],
  "Unable to inspect staged release content.",
);
let stagedOffset = 0;
while (stagedOffset < stagedEntries.length) {
  const terminator = stagedEntries.indexOf(0, stagedOffset);
  if (terminator < 0) {
    process.stderr.write(
      `The ${releaseName} release index is not canonical.\n`,
    );
    process.exit(1);
  }
  const entry = stagedEntries.subarray(stagedOffset, terminator);
  stagedOffset = terminator + 1;
  if (entry.length === 0) continue;

  const separator = entry.indexOf(0x09);
  const metadata = entry.subarray(0, separator).toString("ascii").split(" ");
  const path = entry.subarray(separator + 1);
  const [indexMode, indexObjectId, stage] = metadata;
  if (separator < 0 || metadata.length !== 3 || stage !== "0") {
    process.stderr.write(
      `The ${releaseName} release index is not canonical.\n`,
    );
    process.exit(1);
  }

  try {
    const stat = lstatSync(path);
    let content;
    let worktreeMode;
    if (indexMode === "120000" && stat.isSymbolicLink()) {
      content = readlinkSync(path, { encoding: "buffer" });
      worktreeMode = "120000";
    } else if (
      (indexMode === "100644" || indexMode === "100755") &&
      stat.isFile()
    ) {
      content = readFileSync(path);
      worktreeMode = stat.mode & 0o111 ? "100755" : "100644";
    } else {
      throw new Error("unsupported tracked file type");
    }
    if (worktreeMode !== indexMode || blobObjectId(content) !== indexObjectId) {
      throw new Error("tracked content mismatch");
    }
  } catch {
    process.stderr.write(
      `Tracked ${releaseName} release content must match the reviewed index byte-for-byte.\n`,
    );
    process.exit(1);
  }
}

const trackedEntries = git(
  ["ls-files", "-v"],
  `Unable to inspect tracked ${releaseName} release files.`,
);
if (
  trackedEntries
    .split("\n")
    .filter(Boolean)
    .some((entry) => !entry.startsWith("H "))
) {
  process.stderr.write(
    `Tracked ${releaseName} release files must not use special index flags.\n`,
  );
  process.exit(1);
}

const worktreeStatus = git(
  ["status", "--porcelain=v1", "--untracked-files=all"],
  `Unable to inspect the ${releaseName} release worktree.`,
);
if (worktreeStatus.length !== 0) {
  process.stderr.write(
    `The ${releaseName} release worktree must be clean, including untracked files.\n`,
  );
  process.exit(1);
}

process.stdout.write(`Verified clean ${releaseName} release ${head}.\n`);
