export type ToolAuditOutcome = "success" | "denied" | "failure";
export type ToolAuditReason =
  "ok" | "insufficient_scope" | "profile_unavailable" | "lookup_failed";

const entraIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const profileAliasPattern = /^[A-Z][A-Z0-9_]{0,31}$/;

export type ToolAuditInput = {
  props: Record<string, unknown> | undefined;
  tool: "whoami" | "get_service_ticket";
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
    if (
      !Number.isFinite(now) ||
      !Number.isFinite(input.startedAtMs) ||
      !entraIdPattern.test(correlationId)
    ) {
      return;
    }
    const props = input.props ?? {};
    const event = {
      version: 1,
      event: "mcp_tool_invocation",
      timestamp: new Date(now).toISOString(),
      correlationId,
      ...(typeof props.tenantId === "string" &&
      entraIdPattern.test(props.tenantId)
        ? { tenantId: props.tenantId }
        : {}),
      ...(typeof props.objectId === "string" &&
      entraIdPattern.test(props.objectId)
        ? { objectId: props.objectId }
        : {}),
      ...(typeof props.profileAlias === "string" &&
      profileAliasPattern.test(props.profileAlias)
        ? { profileAlias: props.profileAlias }
        : {}),
      tool: input.tool,
      outcome: input.outcome,
      reason: input.reason,
      durationMs: Math.min(
        300_000,
        Math.max(0, Math.round(now - input.startedAtMs)),
      ),
    };
    (dependencies.logger ?? console.info)(JSON.stringify(event));
  } catch {
    // Audit delivery is best-effort and must not alter the MCP result.
  }
}
