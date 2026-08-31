import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { getMcpAuthContext } from "agents/mcp/server";
import { z } from "zod";
import {
  createConnectWiseClient,
  type ConnectWiseClient,
} from "./connectwise-client";
import {
  resolveConnectWiseCredentials,
  type ConnectWiseCredentials,
} from "./connectwise-profile";
import type { EntraAccessTokenProps } from "./auth-handler";
import {
  emitToolAudit,
  getAuditStartTime,
  type ToolAuditDependencies,
} from "./audit";
import { registerConnectWiseBusinessTools } from "./connectwise-business-tools";

export type AuditedToolDependencies = {
  audit?: ToolAuditDependencies;
};

export function whoamiResult(
  props: Partial<EntraAccessTokenProps> | undefined,
  dependencies: AuditedToolDependencies = {},
): CallToolResult {
  const startedAtMs = getAuditStartTime(dependencies.audit);
  if (!props?.scopes?.includes("mcp:read")) {
    emitToolAudit(
      {
        props,
        tool: "whoami",
        outcome: "denied",
        reason: "insufficient_scope",
        startedAtMs,
      },
      dependencies.audit,
    );
    return {
      isError: true,
      content: [{ type: "text", text: "Insufficient scope" }],
    };
  }
  if (!props.profileAlias) {
    emitToolAudit(
      {
        props,
        tool: "whoami",
        outcome: "denied",
        reason: "profile_unavailable",
        startedAtMs,
      },
      dependencies.audit,
    );
    return {
      isError: true,
      content: [{ type: "text", text: "Authenticated profile unavailable" }],
    };
  }
  emitToolAudit(
    {
      props,
      tool: "whoami",
      outcome: "success",
      reason: "ok",
      startedAtMs,
    },
    dependencies.audit,
  );
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ profileAlias: props.profileAlias }),
      },
    ],
  };
}

const serviceTicketSchema = z.object({
  id: z.number().int().positive(),
  status: z.object({ name: z.string().max(100) }),
});

export type ServiceTicketDependencies = AuditedToolDependencies & {
  createClient?: (
    credentials: ConnectWiseCredentials,
  ) => Pick<ConnectWiseClient, "getServiceTicket">;
  createBusinessClient?: (
    credentials: ConnectWiseCredentials,
  ) => ConnectWiseClient;
  requestLog?: (message: string) => void;
};

export async function getServiceTicketResult(
  props: Partial<EntraAccessTokenProps> | undefined,
  env: object,
  ticketId: number,
  dependencies: ServiceTicketDependencies = {},
): Promise<CallToolResult> {
  const startedAtMs = getAuditStartTime(dependencies.audit);
  if (!props?.scopes?.includes("mcp:read")) {
    emitToolAudit(
      {
        props,
        tool: "get_service_ticket",
        outcome: "denied",
        reason: "insufficient_scope",
        startedAtMs,
      },
      dependencies.audit,
    );
    return {
      isError: true,
      content: [{ type: "text", text: "Insufficient scope" }],
    };
  }
  if (!props.profileAlias) {
    emitToolAudit(
      {
        props,
        tool: "get_service_ticket",
        outcome: "denied",
        reason: "profile_unavailable",
        startedAtMs,
      },
      dependencies.audit,
    );
    return {
      isError: true,
      content: [{ type: "text", text: "Authenticated profile unavailable" }],
    };
  }

  try {
    const requestLog = dependencies.requestLog ?? ((message: string) => {});
    const credentials = resolveConnectWiseCredentials(env, props.profileAlias);
    const clientFactory =
      dependencies.createClient ??
      ((c: ConnectWiseCredentials) =>
        createConnectWiseClient(c, { log: requestLog }));
    const client = clientFactory(credentials);
    const parsed = serviceTicketSchema.parse(
      await client.getServiceTicket(ticketId),
    );
    emitToolAudit(
      {
        props,
        tool: "get_service_ticket",
        outcome: "success",
        reason: "ok",
        startedAtMs,
      },
      dependencies.audit,
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            id: parsed.id,
            status: parsed.status.name,
          }),
        },
      ],
    };
  } catch {
    emitToolAudit(
      {
        props,
        tool: "get_service_ticket",
        outcome: "failure",
        reason: "lookup_failed",
        startedAtMs,
      },
      dependencies.audit,
    );
    return {
      isError: true,
      content: [{ type: "text", text: "ConnectWise ticket lookup failed" }],
    };
  }
}

export function createMcpServer(
  env: object = {},
  dependencies: ServiceTicketDependencies = {},
): McpServer {
  const server = new McpServer({
    name: "ConnectWise MCP v2",
    version: "2.0.0-alpha.1",
  });

  server.registerTool(
    "whoami",
    {
      description: "Return the authenticated ConnectWise profile alias",
      inputSchema: {},
    },
    async (_args): Promise<CallToolResult> => {
      const props = getMcpAuthContext()?.props as
        Partial<EntraAccessTokenProps> | undefined;
      return whoamiResult(props, dependencies);
    },
  );

  server.registerTool(
    "get_service_ticket",
    {
      description:
        "Get non-text metadata for one ConnectWise service ticket by numeric ID",
      inputSchema: { ticketId: z.number().int().positive() },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ ticketId }): Promise<CallToolResult> => {
      const props = getMcpAuthContext()?.props as
        Partial<EntraAccessTokenProps> | undefined;
      return getServiceTicketResult(props, env, ticketId, dependencies);
    },
  );

  registerConnectWiseBusinessTools(
    server,
    env,
    () =>
      getMcpAuthContext()?.props as Partial<EntraAccessTokenProps> | undefined,
    {
      ...(dependencies.audit ? { audit: dependencies.audit } : {}),
      ...(dependencies.createBusinessClient
        ? { createClient: dependencies.createBusinessClient }
        : {}),
      requestLog: dependencies.requestLog ?? console.info,
    },
  );

  return server;
}
