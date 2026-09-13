import { spawnSync } from "node:child_process";
import { lstat } from "node:fs/promises";

const generatedPaths = [
  ".attachment-app-dist/index.html",
  "src/generated/attachment-uploader-html.ts",
];

const tracked = spawnSync(
  "git",
  ["ls-files", "--stage", "--", ...generatedPaths],
  { encoding: "utf8" },
);
if (tracked.status !== 0) {
  process.stderr.write(
    tracked.stderr || "Unable to inspect generated artifacts.\n",
  );
  process.exit(1);
}

const indexEntries = new Map(
  tracked.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const match = /^(\d+) [0-9a-f]+ \d+\t(.+)$/.exec(line);
      return match ? [match[2], match[1]] : [line, "invalid"];
    }),
);

for (const path of generatedPaths) {
  if (indexEntries.get(path) !== "100644") {
    process.stderr.write(
      `${path} must be tracked as a regular non-executable file.\n`,
    );
    process.exit(1);
  }

  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("not a regular file");
    }
  } catch {
    process.stderr.write(`${path} must exist as a regular file.\n`);
    process.exit(1);
  }
}

const diff = spawnSync("git", ["diff", "--quiet", "--", ...generatedPaths]);
if (diff.status !== 0) {
  process.stderr.write(
    "Attachment app artifacts are stale; run npm run build:attachment-app and commit both generated files.\n",
  );
  process.exit(1);
}
