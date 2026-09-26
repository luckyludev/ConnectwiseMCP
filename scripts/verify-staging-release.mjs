import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";

const approvedRelease = process.env.STAGING_RELEASE_SHA;
if (!approvedRelease || !/^[0-9a-f]{40}$/u.test(approvedRelease)) {
  process.stderr.write(
    "STAGING_RELEASE_SHA must be the approved full 40-character lowercase release commit.\n",
  );
  process.exit(1);
}

const gitEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
);

function git(args, failureMessage) {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    env: gitEnvironment,
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || `${failureMessage}\n`);
    process.exit(1);
  }
  return result.stdout;
}

const repositoryRoot = git(
  ["rev-parse", "--show-toplevel"],
  "Unable to resolve the staging release worktree.",
).trim();
if (realpathSync(repositoryRoot) !== realpathSync(process.cwd())) {
  process.stderr.write(
    "The staging release guard must run from the repository root.\n",
  );
  process.exit(1);
}

const head = git(
  ["rev-parse", "--verify", "HEAD^{commit}"],
  "Unable to resolve the staging release commit.",
).trim();
if (head !== approvedRelease) {
  process.stderr.write(
    "STAGING_RELEASE_SHA does not match the checked-out staging release commit.\n",
  );
  process.exit(1);
}

const trackedEntries = git(
  ["ls-files", "-v"],
  "Unable to inspect tracked staging release files.",
);
if (
  trackedEntries
    .split("\n")
    .filter(Boolean)
    .some((entry) => !entry.startsWith("H "))
) {
  process.stderr.write(
    "Tracked staging release files must not use special index flags.\n",
  );
  process.exit(1);
}

const worktreeStatus = git(
  ["status", "--porcelain=v1", "--untracked-files=all"],
  "Unable to inspect the staging release worktree.",
);
if (worktreeStatus.length !== 0) {
  process.stderr.write(
    "The staging release worktree must be clean, including untracked files.\n",
  );
  process.exit(1);
}

process.stdout.write(`Verified clean staging release ${head}.\n`);
