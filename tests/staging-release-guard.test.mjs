import { spawnSync } from "node:child_process";
import { accessSync, chmodSync, constants } from "node:fs";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const guardPath = fileURLToPath(
  new URL("../scripts/verify-staging-release.mjs", import.meta.url),
);

function resolveExecutable(name) {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue searching PATH.
    }
  }
  throw new Error(`Unable to resolve ${name} from PATH.`);
}

const realGit = resolveExecutable("git");
const repositoryEnvironments = new Map();

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

const CANONICAL_REPOSITORY_URL =
  "https://github.com/luckyludev/ConnectwiseMCP.git";

async function createRepository() {
  const root = await mkdtemp(join(tmpdir(), "cw-staging-release-"));
  const cwd = join(root, "worktree");
  const bare = join(root, "origin.git");
  const bin = join(root, "bin");
  const gitShim = join(bin, "git");
  await mkdir(cwd);
  await mkdir(bin);
  git(root, ["init", "--quiet", "--bare", bare]);
  await writeFile(
    gitShim,
    `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
const canonical = ${JSON.stringify(CANONICAL_REPOSITORY_URL)};
const replacement = \`file://\${process.env.TEST_GIT_REMOTE}/\`;
const args = process.argv.slice(2).map((argument) =>
  argument === canonical ? replacement : argument,
);
const result = spawnSync(process.env.REAL_GIT, args, {
  env: process.env,
  stdio: "inherit",
});
process.exit(result.status ?? 1);
`,
  );
  chmodSync(gitShim, 0o755);
  git(cwd, ["init", "--quiet"]);
  git(cwd, ["config", "user.name", "Staging Guard Test"]);
  git(cwd, ["config", "user.email", "staging-guard@example.invalid"]);
  git(cwd, ["remote", "add", "origin", CANONICAL_REPOSITORY_URL]);
  await writeFile(join(cwd, "release.txt"), "reviewed\n");
  await symlink("release.txt", join(cwd, "release-link"));
  git(cwd, ["add", "release.txt", "release-link"]);
  git(cwd, ["commit", "--quiet", "-m", "reviewed release"]);
  const head = git(cwd, ["rev-parse", "HEAD"]);
  git(cwd, ["push", "--quiet", `file://${bare}`, "HEAD:refs/heads/main"]);
  repositoryEnvironments.set(cwd, {
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    REAL_GIT: realGit,
    TEST_GIT_REMOTE: bare,
  });
  return { bare, cwd, head, root };
}

function runGuard(cwd, releaseSha, environmentOverrides = {}) {
  const env = {
    ...process.env,
    ...repositoryEnvironments.get(cwd),
    ...environmentOverrides,
  };
  if (releaseSha === undefined) {
    delete env.STAGING_RELEASE_SHA;
  } else {
    env.STAGING_RELEASE_SHA = releaseSha;
  }
  return spawnSync(process.execPath, [guardPath], {
    cwd,
    env,
    encoding: "utf8",
  });
}

async function withRepository(callback) {
  const repository = await createRepository();
  try {
    await callback(repository);
  } finally {
    repositoryEnvironments.delete(repository.cwd);
    await rm(repository.root, { recursive: true, force: true });
  }
}

describe("staging release guard", () => {
  it("accepts only a clean worktree at the exact approved commit", async () => {
    await withRepository(async ({ cwd, head }) => {
      const result = runGuard(cwd, head);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(`Verified clean staging release ${head}.\n`);
    });
  });

  it("accepts a reviewed release already contained in fetched origin/main", async () => {
    await withRepository(async ({ bare, cwd, head }) => {
      await writeFile(join(cwd, "release.txt"), "newer reviewed release\n");
      git(cwd, ["add", "release.txt"]);
      git(cwd, ["commit", "--quiet", "-m", "newer reviewed release"]);
      git(cwd, ["push", "--quiet", `file://${bare}`, "HEAD:refs/heads/main"]);
      git(cwd, ["checkout", "--quiet", "--detach", head]);

      const result = runGuard(cwd, head);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(`Verified clean staging release ${head}.\n`);
    });
  });

  it("rejects a clean local-only descendant of fetched origin/main", async () => {
    await withRepository(async ({ cwd }) => {
      await writeFile(join(cwd, "release.txt"), "local-only release\n");
      git(cwd, ["add", "release.txt"]);
      git(cwd, ["commit", "--quiet", "-m", "local-only release"]);
      const localHead = git(cwd, ["rev-parse", "HEAD"]);

      const result = runGuard(cwd, localHead);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "The staging release commit is not contained in fetched origin/main.",
      );
    });
  });

  it("rejects a release unrelated to fetched origin/main", async () => {
    await withRepository(async ({ cwd }) => {
      git(cwd, ["checkout", "--quiet", "--orphan", "unrelated"]);
      await writeFile(join(cwd, "release.txt"), "unrelated release\n");
      git(cwd, ["add", "release.txt"]);
      git(cwd, ["commit", "--quiet", "-m", "unrelated release"]);
      const unrelatedHead = git(cwd, ["rev-parse", "HEAD"]);

      const result = runGuard(cwd, unrelatedHead);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "The staging release commit is not contained in fetched origin/main.",
      );
    });
  });

  it("rejects a noncanonical origin fetch URL", async () => {
    await withRepository(async ({ bare, cwd, head }) => {
      git(cwd, ["remote", "set-url", "origin", `file://${bare}`]);

      const result = runGuard(cwd, head);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "The origin fetch URL does not match the canonical repository.",
      );
    });
  });

  it("rejects Git URL rewrite rules before canonical fetch", async () => {
    await withRepository(async ({ bare, cwd, head }) => {
      git(cwd, [
        "config",
        `url.file://${bare}/.insteadOf`,
        CANONICAL_REPOSITORY_URL,
      ]);

      const result = runGuard(cwd, head);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "Git URL rewrite rules are not allowed for staging release verification.",
      );
    });
  });

  it("ignores replacement refs when checking review ancestry", async () => {
    await withRepository(async ({ cwd, head: reviewedHead }) => {
      await writeFile(join(cwd, "release.txt"), "local-only release\n");
      git(cwd, ["add", "release.txt"]);
      git(cwd, ["commit", "--quiet", "-m", "local-only release"]);
      const localHead = git(cwd, ["rev-parse", "HEAD"]);
      const reviewedTree = git(cwd, ["rev-parse", `${reviewedHead}^{tree}`]);
      const syntheticReviewedHead = git(cwd, [
        "commit-tree",
        reviewedTree,
        "-p",
        localHead,
        "-m",
        "synthetic review boundary",
      ]);
      git(cwd, ["replace", reviewedHead, syntheticReviewedHead]);

      const result = runGuard(cwd, localHead);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "The staging release commit is not contained in fetched origin/main.",
      );
    });
  });

  it("rejects legacy graft metadata before ancestry checks", async () => {
    await withRepository(async ({ cwd, head: reviewedHead }) => {
      git(cwd, ["checkout", "--quiet", "--orphan", "unreviewed"]);
      await writeFile(join(cwd, "release.txt"), "unreviewed release\n");
      git(cwd, ["add", "release.txt"]);
      git(cwd, ["commit", "--quiet", "-m", "unreviewed release"]);
      const localHead = git(cwd, ["rev-parse", "HEAD"]);
      await writeFile(
        join(cwd, ".git", "info", "grafts"),
        `${reviewedHead} ${localHead}\n`,
      );

      const result = runGuard(cwd, localHead);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "Legacy Git graft metadata is not allowed for staging release verification.",
      );
    });
  });

  it("fails closed when canonical origin/main is missing", async () => {
    await withRepository(async ({ bare, cwd, head }) => {
      git(bare, ["update-ref", "-d", "refs/heads/main"]);

      const result = runGuard(cwd, head);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "Unable to fetch the canonical origin/main review boundary.",
      );
    });
  });

  it.each([undefined, "abc", "A".repeat(40), "0".repeat(39)])(
    "rejects a missing or malformed approved release SHA (%s)",
    async (releaseSha) => {
      await withRepository(async ({ cwd }) => {
        const result = runGuard(cwd, releaseSha);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
          "STAGING_RELEASE_SHA must be the approved full 40-character lowercase release commit.",
        );
      });
    },
  );

  it("rejects a different approved release commit", async () => {
    await withRepository(async ({ cwd }) => {
      const result = runGuard(cwd, "0".repeat(40));

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "STAGING_RELEASE_SHA does not match the checked-out staging release commit.",
      );
    });
  });

  it("rejects modified tracked files", async () => {
    await withRepository(async ({ cwd, head }) => {
      await writeFile(join(cwd, "release.txt"), "modified\n");
      const result = runGuard(cwd, head);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "Tracked staging release content must match the reviewed index byte-for-byte.",
      );
    });
  });

  it("rejects a changed tracked symlink target", async () => {
    await withRepository(async ({ cwd, head }) => {
      await unlink(join(cwd, "release-link"));
      await symlink("different-target", join(cwd, "release-link"));

      const result = runGuard(cwd, head);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "Tracked staging release content must match the reviewed index byte-for-byte.",
      );
    });
  });

  it("rejects a changed tracked executable mode", async () => {
    await withRepository(async ({ cwd, head }) => {
      chmodSync(join(cwd, "release.txt"), 0o755);

      const result = runGuard(cwd, head);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "Tracked staging release content must match the reviewed index byte-for-byte.",
      );
    });
  });

  it("rejects tracked changes hidden by a configured fsmonitor hook", async () => {
    await withRepository(async ({ cwd, head }) => {
      const hook = join(cwd, ".git", "hooks", "fsmonitor-test");
      await writeFile(hook, "#!/bin/sh\nprintf 'token\\0'\n");
      chmodSync(hook, 0o755);
      git(cwd, ["config", "core.fsmonitor", hook]);
      git(cwd, ["status", "--porcelain=v1"]);
      await writeFile(join(cwd, "release.txt"), "hidden modification\n");

      const result = runGuard(cwd, head);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "Tracked staging release content must match the reviewed index byte-for-byte.",
      );
    });
  });

  it("rejects tracked changes concealed by a clean filter", async () => {
    await withRepository(async ({ cwd, head }) => {
      await writeFile(
        join(cwd, ".git", "info", "attributes"),
        "release.txt filter=mask\n",
      );
      git(cwd, ["config", "filter.mask.clean", "printf 'reviewed\\n'"]);
      await writeFile(join(cwd, "release.txt"), "hidden modification\n");
      git(cwd, ["add", "release.txt"]);
      git(cwd, ["diff", "--cached", "--quiet", "HEAD", "--"]);

      const result = runGuard(cwd, head);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "Tracked staging release content must match the reviewed index byte-for-byte.",
      );
    });
  });

  it("rejects staged changes", async () => {
    await withRepository(async ({ cwd, head }) => {
      await writeFile(join(cwd, "release.txt"), "staged modification\n");
      git(cwd, ["add", "release.txt"]);
      const result = runGuard(cwd, head);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "The staging release index must match the reviewed commit.",
      );
    });
  });

  it.each(["--skip-worktree", "--assume-unchanged"])(
    "rejects tracked files marked %s",
    async (indexFlag) => {
      await withRepository(async ({ cwd, head }) => {
        git(cwd, ["update-index", indexFlag, "release.txt"]);
        const result = runGuard(cwd, head);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
          "Tracked staging release files must not use special index flags.",
        );
      });
    },
  );

  it("ignores inherited Git repository overrides", async () => {
    const otherRepository = await createRepository();
    try {
      await withRepository(async ({ cwd, head }) => {
        await writeFile(join(cwd, "release.txt"), "modified\n");
        const result = runGuard(cwd, head, {
          GIT_DIR: join(otherRepository.cwd, ".git"),
          GIT_WORK_TREE: otherRepository.cwd,
        });

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
          "Tracked staging release content must match the reviewed index byte-for-byte.",
        );
      });
    } finally {
      repositoryEnvironments.delete(otherRepository.cwd);
      await rm(otherRepository.root, { recursive: true, force: true });
    }
  });

  it("rejects untracked files", async () => {
    await withRepository(async ({ cwd, head }) => {
      await writeFile(join(cwd, "untracked.txt"), "not reviewed\n");
      const result = runGuard(cwd, head);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "The staging release worktree must be clean, including untracked files.",
      );
    });
  });
});
