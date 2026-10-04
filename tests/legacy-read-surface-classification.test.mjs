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

const NARROW_ADDITION_ACCESS = Object.freeze({
  "Image attachment from chat": {
    open_attachment_uploader: "read",
    upload_connectwise_image: "write",
    attach_image_to_ticket: "write",
    attach_image_to_time_entry: "write",
  },
});

const V2_ADDITION_ACCESS = Object.freeze({
  whoami: "read",
  get_service_ticket: "read",
  get_service_boards: "read",
  get_board_options: "read",
  list_board_tickets: "read",
  get_service_statuses: "read",
  get_service_priorities: "read",
  get_service_sources: "read",
  get_my_member: "read",
  search_members: "read",
  search_companies: "read",
  search_contacts: "read",
  list_time_entries: "read",
  list_schedule_entries: "read",
  get_time_sheets: "read",
  call_connectwise: "read",
  create_schedule_entry: "write",
  update_schedule_entry: "write",
  delete_schedule_entry: "write",
  create_time_entry: "write",
  create_service_ticket: "write",
  update_service_ticket: "write",
});

const ACTIVE_DECISIONS = new Set([
  "Added narrowly",
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
    .filter((line) => line.startsWith("|"))
    .map((line) => {
      const columns = line.split("|").slice(1, -1);
      if (columns.length !== 3) {
        throw new Error("active legacy tool decision row is malformed");
      }
      return columns;
    })
    .filter((columns) => {
      const decision = columns[1].trim().replaceAll("**", "");
      return decision !== "V2 decision" && !/^-+$/.test(decision);
    })
    .map((columns) => {
      const legacyTools = [...columns[0].matchAll(/`([a-z][a-z0-9_]*)`/g)].map(
        ([, name]) => name,
      );
      const legacySurface = columns[0].trim().replaceAll("`", "");
      const decision = columns[1].trim().replaceAll("**", "");
      return { legacyTools, legacySurface, decision };
    });
}

function classifiedLegacyTools(markdown) {
  return activeDecisionRows(markdown)
    .flatMap(({ legacyTools }) => legacyTools)
    .sort();
}

function v2AdditionRows(markdown) {
  const table = markdown
    .split("## V2 bounded additions", 2)[1]
    ?.split("## Remaining boundary", 1)[0];

  if (!table) {
    throw new Error("V2 bounded additions table is missing");
  }

  const lines = table.split("\n").filter((line) => line.startsWith("|"));
  if (lines.length < 3) {
    throw new Error("V2 bounded additions table is incomplete");
  }

  const columns = lines.map((line) => {
    const row = line.split("|").slice(1, -1);
    if (row.length !== 3) {
      throw new Error("V2 bounded addition row is malformed");
    }
    return row;
  });

  const [header, separator, ...dataRows] = columns;
  if (
    header[0].trim() !== "V2 tool(s)" ||
    header[1].trim() !== "Access" ||
    header[2].trim() !== "Bounded purpose" ||
    !separator.every((cell) => /^\s*:?-{3,}:?\s*$/.test(cell))
  ) {
    throw new Error("V2 bounded additions table header is malformed");
  }

  return dataRows.map((row) => {
    const toolCell = row[0].trim();
    const tools = [...toolCell.matchAll(/`([a-z][a-z0-9_]*)`/g)].map(
      ([, name]) => name,
    );
    const access = row[1].trim().replaceAll("**", "").toLowerCase();
    if (
      !/^`[a-z][a-z0-9_]*`(?:,\s*`[a-z][a-z0-9_]*`)*$/.test(toolCell) ||
      (access !== "read" && access !== "write") ||
      row[2].trim().length === 0
    ) {
      throw new Error(
        "V2 bounded addition requires tools, read/write access, and purpose",
      );
    }
    return { tools, access };
  });
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

    const excludedTools = rows
      .filter(({ decision }) => decision === "Excluded")
      .flatMap(({ legacyTools }) => legacyTools);
    expect(excludedTools).toHaveLength(15);
    for (const excludedTool of excludedTools) {
      expect(TOOL_ACCESS).not.toHaveProperty(excludedTool);
    }

    const additions = rows.filter(({ decision }) =>
      decision.startsWith("Added"),
    );
    expect(additions).toHaveLength(1);
    expect(additions[0].legacyTools).toEqual([]);
    expect(additions[0].legacySurface).toBe("Image attachment from chat");
    expect(additions[0].decision).toBe("Added narrowly");
    for (const [tool, access] of Object.entries(
      NARROW_ADDITION_ACCESS[additions[0].legacySurface],
    )) {
      expect(TOOL_ACCESS[tool]).toBe(access);
    }
  });

  it("gives every registered V2 tool exactly one migration or addition decision", () => {
    const rows = v2AdditionRows(classification);
    const documentedAdditions = rows.flatMap(({ tools, access }) =>
      tools.map((tool) => [tool, access]),
    );

    expect(documentedAdditions).toHaveLength(
      Object.keys(V2_ADDITION_ACCESS).length,
    );
    expect(Object.fromEntries(documentedAdditions)).toEqual(V2_ADDITION_ACCESS);

    const migratedV2Tools = Object.values(MIGRATED_TOOL_ACCESS).flatMap(
      ({ v2Tools }) => v2Tools,
    );
    const narrowAdditionTools = Object.values(NARROW_ADDITION_ACCESS).flatMap(
      (tools) => Object.keys(tools),
    );
    const allDecidedTools = [
      ...migratedV2Tools,
      ...narrowAdditionTools,
      ...Object.keys(V2_ADDITION_ACCESS),
    ];

    expect(new Set(allDecidedTools).size).toBe(allDecidedTools.length);
    expect(allDecidedTools.sort()).toEqual(Object.keys(TOOL_ACCESS).sort());
    for (const [tool, access] of Object.entries(V2_ADDITION_ACCESS)) {
      expect(TOOL_ACCESS[tool]).toBe(access);
    }
  });
});
