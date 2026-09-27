import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const legacyServer = readFileSync(
  `${repositoryRoot}/deploy/cwm-mcp/api_gateway/server.py`,
  "utf8",
);
const classification = readFileSync(
  `${repositoryRoot}/docs/legacy-read-surface-classification.md`,
  "utf8",
);

function activeLegacyTools(source) {
  return [...source.matchAll(/@mcp\.tool\(\)\s+async def\s+(\w+)\s*\(/g)].map(
    ([, name]) => name,
  );
}

function activeLegacyToolDecoratorCount(source) {
  return [...source.matchAll(/^\s*@mcp\.tool\b/gm)].length;
}

function classifiedLegacyTools(markdown) {
  const table = markdown
    .split("## Active legacy tool decisions", 2)[1]
    ?.split("## V2 bounded additions", 1)[0];

  if (!table) {
    throw new Error("active legacy tool decision table is missing");
  }

  return [...table.matchAll(/^\|([^|]+)\|/gm)]
    .flatMap(([, firstColumn]) =>
      [...firstColumn.matchAll(/`([a-z][a-z0-9_]*)`/g)].map(([, name]) => name),
    )
    .sort();
}

describe("legacy read-surface classification", () => {
  it("classifies every active rollback tool exactly once", () => {
    const activeTools = activeLegacyTools(legacyServer);

    expect(activeTools).toHaveLength(
      activeLegacyToolDecoratorCount(legacyServer),
    );
    expect(new Set(activeTools).size).toBe(activeTools.length);
    expect(classifiedLegacyTools(classification)).toEqual(activeTools.sort());
  });
});
