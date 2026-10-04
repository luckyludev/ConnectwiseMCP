import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { TOOL_ACCESS } from "../src/tool-access";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const legacyServer = readFileSync(
  `${repositoryRoot}/deploy/cwm-mcp/api_gateway/server.py`,
  "utf8",
);
const classification = readFileSync(
  `${repositoryRoot}/docs/legacy-read-surface-classification.md`,
  "utf8",
);

const MIGRATED_TOOL_ACCESS = Object.freeze({
  get_ticket_notes_with_content: {
    access: "read",
    v2Tools: ["get_ticket_notes_with_content"],
  },
  get_ticket_attachments_with_details: {
    access: "read",
    v2Tools: ["get_ticket_attachments_with_details"],
  },
  get_complete_ticket_content: {
    access: "read",
    v2Tools: [
      "get_complete_ticket_content",
      "list_ticket_tasks",
      "list_ticket_time_entries",
    ],
  },
  download_ticket_attachment: {
    access: "read",
    v2Tools: ["download_ticket_attachment"],
  },
  create_ticket_note: {
    access: "write",
    v2Tools: ["create_ticket_note"],
  },
  search_tickets_by_content: {
    access: "read",
    v2Tools: ["search_tickets_by_content"],
  },
  get_agreement_additions: {
    access: "read",
    v2Tools: ["get_agreement_additions"],
  },
  get_agreement_additions_summary: {
    access: "read",
    v2Tools: ["get_agreement_additions_summary"],
  },
  get_agreement_billing_summary: {
    access: "read",
    v2Tools: ["get_agreement_billing_summary"],
  },
  create_agreement_addition: {
    access: "write",
    v2Tools: ["create_agreement_addition"],
  },
  search_agreement_additions: {
    access: "read",
    v2Tools: ["search_agreement_additions"],
  },
});

const ACTIVE_DECISIONS = new Set([
  "Excluded",
  "Migrated",
  "Migrated as metadata",
  "Migrated narrowly",
  "Migrated with bounds",
]);

function activeLegacyTools(source) {
  return [...source.matchAll(/@mcp\.tool\(\)\s+async def\s+(\w+)\s*\(/g)].map(
    ([, name]) => name,
  );
}

function activeLegacyToolDecoratorCount(source) {
  return [...source.matchAll(/^\s*@mcp\.tool\b/gm)].length;
}

function activeDecisionRows(markdown) {
  const table = markdown
    .split("## Active legacy tool decisions", 2)[1]
    ?.split("## V2 bounded additions", 1)[0];

  if (!table) {
    throw new Error("active legacy tool decision table is missing");
  }

  return table
    .split("\n")
    .filter((line) => /^\|.*`[a-z][a-z0-9_]*`/.test(line))
    .map((line) => {
      const columns = line.split("|").slice(1, -1);
      if (columns.length !== 3) {
        throw new Error("active legacy tool decision row is malformed");
      }
      const legacyTools = [...columns[0].matchAll(/`([a-z][a-z0-9_]*)`/g)].map(
        ([, name]) => name,
      );
      const decision = columns[1].trim().replaceAll("**", "");
      return { legacyTools, decision };
    });
}

function classifiedLegacyTools(markdown) {
  return activeDecisionRows(markdown)
    .flatMap(({ legacyTools }) => legacyTools)
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

  it("uses explicit decisions and binds every migration to V2 tool access", () => {
    const rows = activeDecisionRows(classification);
    expect(rows.every(({ decision }) => ACTIVE_DECISIONS.has(decision))).toBe(
      true,
    );

    const migratedTools = rows
      .filter(({ decision }) => decision.startsWith("Migrated"))
      .flatMap(({ legacyTools }) => legacyTools)
      .sort();
    expect(migratedTools).toEqual(Object.keys(MIGRATED_TOOL_ACCESS).sort());

    for (const [legacyTool, { access, v2Tools }] of Object.entries(
      MIGRATED_TOOL_ACCESS,
    )) {
      expect(migratedTools).toContain(legacyTool);
      for (const v2Tool of v2Tools) {
        expect(TOOL_ACCESS[v2Tool]).toBe(access);
      }
    }
  });
});
