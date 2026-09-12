const toolAuditOutcomes = ["success", "denied", "failure"] as const;
const toolAuditReasons = [
  "ok",
  "insufficient_scope",
  "profile_unavailable",
  "lookup_failed",
  "connectwise_denied",
  "operation_failed",
] as const;
const toolAuditNames = [
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
] as const;

export type ToolAuditOutcome = (typeof toolAuditOutcomes)[number];
export type ToolAuditReason = (typeof toolAuditReasons)[number];
export type ToolAuditName = (typeof toolAuditNames)[number];

const toolAuditOutcomeAllowlist: ReadonlySet<unknown> = new Set(
  toolAuditOutcomes,
);
const toolAuditReasonAllowlist: ReadonlySet<unknown> = new Set(
  toolAuditReasons,
);
const toolAuditNameAllowlist: ReadonlySet<unknown> = new Set(toolAuditNames);

const entraIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const profileAliasPattern = /^[A-Z][A-Z0-9_]{0,31}$/;

export type ToolAuditInput = {
  props: unknown;
  tool: ToolAuditName;
  outcome: ToolAuditOutcome;
  reason: ToolAuditReason;
  startedAtMs: number;
};

export type ToolAuditDependencies = {
  logger?: (message: string) => void;
  now?: () => number;
  createCorrelationId?: () => string;
};

export function getAuditStartTime(
  dependencies: ToolAuditDependencies = {},
): number {
  try {
    const now = dependencies.now?.() ?? Date.now();
    return Number.isFinite(now) ? now : Date.now();
  } catch {
    return Date.now();
  }
}

export function emitToolAudit(
  input: ToolAuditInput,
  dependencies: ToolAuditDependencies = {},
): void {
  try {
    const now = dependencies.now?.() ?? Date.now();
    const correlationId =
      dependencies.createCorrelationId?.() ?? crypto.randomUUID();
    const startedAtMs = input.startedAtMs;
    const tool: unknown = input.tool;
    const outcome: unknown = input.outcome;
    const reason: unknown = input.reason;
    if (
      !Number.isFinite(now) ||
      !Number.isFinite(startedAtMs) ||
      !entraIdPattern.test(correlationId) ||
      !toolAuditNameAllowlist.has(tool) ||
      !toolAuditOutcomeAllowlist.has(outcome) ||
      !toolAuditReasonAllowlist.has(reason)
    ) {
      return;
    }
    const props =
      input.props !== null && typeof input.props === "object"
        ? (input.props as Record<string, unknown>)
        : {};
    const tenantId = props.tenantId;
    const objectId = props.objectId;
    const profileAlias = props.profileAlias;
    const event = {
      version: 1,
      event: "mcp_tool_invocation",
      timestamp: new Date(now).toISOString(),
      correlationId,
      ...(typeof tenantId === "string" && entraIdPattern.test(tenantId)
        ? { tenantId }
        : {}),
      ...(typeof objectId === "string" && entraIdPattern.test(objectId)
        ? { objectId }
        : {}),
      ...(typeof profileAlias === "string" &&
      profileAliasPattern.test(profileAlias)
        ? { profileAlias }
        : {}),
      tool,
      outcome,
      reason,
      durationMs: Math.min(300_000, Math.max(0, Math.round(now - startedAtMs))),
    };
    (dependencies.logger ?? console.info)(JSON.stringify(event));
  } catch {
    // Audit delivery is best-effort and must not alter the MCP result.
  }
}
