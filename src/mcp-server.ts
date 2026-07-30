import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { getMcpAuthContext } from "agents/mcp/server";
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

export function createMcpServer(): McpServer {
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

  return server;
}
