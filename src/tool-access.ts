import type { McpScope } from "./auth-scopes";
import type { ToolAuditName } from "./audit";

export const TOOL_ACCESS = Object.freeze({
  whoami: "read",
  get_service_ticket: "read",
  search_tickets_by_content: "read",
  get_ticket_notes_with_content: "read",
  get_ticket_attachments_with_details: "read",
  list_ticket_tasks: "read",
  list_ticket_time_entries: "read",
  get_complete_ticket_content: "read",
  create_ticket_note: "write",
  attach_image_to_ticket: "write",
  attach_image_to_time_entry: "write",
  get_service_boards: "read",
  get_board_options: "read",
  list_board_tickets: "read",
  get_service_statuses: "read",
  get_service_priorities: "read",
  get_service_sources: "read",
  get_my_member: "read",
  list_members: "read",
  search_companies: "read",
  search_contacts: "read",
  list_time_entries: "read",
  list_schedule_entries: "read",
  get_time_sheets: "read",
  download_ticket_attachment: "read",
  open_attachment_uploader: "read",
  upload_connectwise_image: "write",
  call_connectwise: "read",
  get_agreement_additions: "read",
  get_agreement_additions_summary: "read",
  create_agreement_addition: "write",
  search_agreement_additions: "read",
  get_agreement_billing_summary: "read",
  create_schedule_entry: "write",
  update_schedule_entry: "write",
  delete_schedule_entry: "write",
  create_time_entry: "write",
  create_service_ticket: "write",
  update_service_ticket: "write",
} as const satisfies Record<ToolAuditName, "read" | "write">);

const READ_SCOPES: readonly McpScope[] = Object.freeze(["mcp:read"]);
const WRITE_SCOPES: readonly McpScope[] = Object.freeze([
  "mcp:read",
  "mcp:write",
]);

export function requiredMcpScopes(tool: ToolAuditName): readonly McpScope[] {
  return TOOL_ACCESS[tool] === "write" ? WRITE_SCOPES : READ_SCOPES;
}
