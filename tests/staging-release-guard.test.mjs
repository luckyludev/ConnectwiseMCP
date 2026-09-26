import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const guardPath = fileURLToPath(
  new URL("../scripts/verify-staging-release.mjs", import.meta.url),
);

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

async function createRepository() {
  const cwd = await mkdtemp(join(tmpdir(), "cw-staging-release-"));
  git(cwd, ["init", "--quiet"]);
  git(cwd, ["config", "user.name", "Staging Guard Test"]);
  git(cwd, ["config", "user.email", "staging-guard@example.invalid"]);
  await writeFile(join(cwd, "release.txt"), "reviewed\n");
  git(cwd, ["add", "release.txt"]);
  git(cwd, ["commit", "--quiet", "-m", "reviewed release"]);
  return { cwd, head: git(cwd, ["rev-parse", "HEAD"]) };
}

function runGuard(cwd, releaseSha, environmentOverrides = {}) {
  const env = { ...process.env, ...environmentOverrides };
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
    await rm(repository.cwd, { recursive: true, force: true });
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
        "The staging release worktree must be clean, including untracked files.",
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
        "The staging release worktree must be clean, including untracked files.",
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
          "The staging release worktree must be clean, including untracked files.",
        );
      });
    } finally {
      await rm(otherRepository.cwd, { recursive: true, force: true });
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
