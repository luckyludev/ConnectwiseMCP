export const EXPECTED_TOOL_NAMES = Object.freeze([
  "whoami",
  "get_service_ticket",
  "search_tickets_by_content",
  "get_ticket_notes_with_content",
  "get_ticket_attachments_with_details",
  "list_ticket_tasks",
  "list_ticket_time_entries",
  "get_complete_ticket_content",
  "create_ticket_note",
  "attach_image_to_ticket",
  "attach_image_to_time_entry",
  "get_service_boards",
  "get_board_options",
  "list_board_tickets",
  "get_service_statuses",
  "get_service_priorities",
  "get_service_sources",
  "get_my_member",
  "list_members",
  "search_companies",
  "search_contacts",
  "list_time_entries",
  "list_schedule_entries",
  "get_time_sheets",
  "get_document",
  "download_document",
  "open_attachment_uploader",
  "upload_connectwise_image",
  "call_connectwise",
  "get_agreement_additions",
  "get_agreement_additions_summary",
  "create_agreement_addition",
  "search_agreement_additions",
  "get_agreement_billing_summary",
  "create_schedule_entry",
  "update_schedule_entry",
  "delete_schedule_entry",
  "create_time_entry",
  "create_service_ticket",
  "update_service_ticket",
]);

const APP_ONLY_TOOL_NAME = "upload_connectwise_image";

function visibility(tool) {
  return tool?._meta?.ui?.visibility;
}

export function validateStagingToolsListResult(result) {
  if (result === null || typeof result !== "object") {
    return "tools/list returned an invalid result";
  }
  if (result.nextCursor !== undefined) {
    return "tools/list pagination is not allowed for the fixed catalog";
  }
  return validateStagingToolCatalog(result.tools);
}

export function validateStagingToolCatalog(tools) {
  if (!Array.isArray(tools)) return "tools/list returned an invalid catalog";
  if (
    tools.some(
      (tool) =>
        tool === null ||
        typeof tool !== "object" ||
        typeof tool.name !== "string",
    )
  ) {
    return "tools/list contains malformed tool entries";
  }

  const names = tools.map((tool) => tool.name);
  if (names.length !== EXPECTED_TOOL_NAMES.length) {
    return `tools/list returned ${names.length} tools; expected ${EXPECTED_TOOL_NAMES.length}`;
  }
  if (new Set(names).size !== names.length) {
    return "tools/list contains duplicate tool names";
  }

  const expected = new Set(EXPECTED_TOOL_NAMES);
  const missingCount = EXPECTED_TOOL_NAMES.filter(
    (name) => !names.includes(name),
  ).length;
  if (missingCount > 0) {
    return `tools/list is missing ${missingCount} expected tool(s)`;
  }
  const unexpectedCount = names.filter((name) => !expected.has(name)).length;
  if (unexpectedCount > 0) {
    return `tools/list exposes ${unexpectedCount} unexpected tool(s)`;
  }

  for (const tool of tools) {
    const declaredVisibility = visibility(tool);
    if (tool.name === APP_ONLY_TOOL_NAME) {
      if (
        !Array.isArray(declaredVisibility) ||
        declaredVisibility.length !== 1 ||
        declaredVisibility[0] !== "app"
      ) {
        return "tools/list does not preserve the app-only upload boundary";
      }
      continue;
    }
    if (
      declaredVisibility !== undefined &&
      (!Array.isArray(declaredVisibility) ||
        !declaredVisibility.includes("model"))
    ) {
      return "tools/list hides an unexpected tool from model clients";
    }
  }

  return undefined;
}
