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

export function whoamiResult(
  props: Partial<EntraAccessTokenProps> | undefined,
): CallToolResult {
  if (!props?.scopes?.includes("mcp:read")) {
    return {
      isError: true,
      content: [{ type: "text", text: "Insufficient scope" }],
    };
  }
  if (!props.profileAlias) {
    return {
      isError: true,
      content: [{ type: "text", text: "Authenticated profile unavailable" }],
    };
  }
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
  summary: z.string().max(1_000),
  status: z.object({ name: z.string().max(100) }),
});

export type ServiceTicketDependencies = {
  createClient?: (credentials: ConnectWiseCredentials) => ConnectWiseClient;
};

export async function getServiceTicketResult(
  props: Partial<EntraAccessTokenProps> | undefined,
  env: object,
  ticketId: number,
  dependencies: ServiceTicketDependencies = {},
): Promise<CallToolResult> {
  if (!props?.scopes?.includes("mcp:read")) {
    return {
      isError: true,
      content: [{ type: "text", text: "Insufficient scope" }],
    };
  }
  if (!props.profileAlias) {
    return {
      isError: true,
      content: [{ type: "text", text: "Authenticated profile unavailable" }],
    };
  }

  try {
    const credentials = resolveConnectWiseCredentials(env, props.profileAlias);
    const client = (dependencies.createClient ?? createConnectWiseClient)(
      credentials,
    );
    const parsed = serviceTicketSchema.parse(
      await client.getServiceTicket(ticketId),
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            id: parsed.id,
            summary: parsed.summary,
            status: parsed.status.name,
          }),
        },
      ],
    };
  } catch {
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
      return whoamiResult(props);
    },
  );

  server.registerTool(
    "get_service_ticket",
    {
      description: "Get one ConnectWise service ticket by numeric ID",
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

  return server;
}
