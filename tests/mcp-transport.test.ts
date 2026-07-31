import { createMcpHandler } from "agents/mcp/server";
import { describe, expect, it } from "vitest";
import { createMcpServer } from "../src/mcp-server";

const profile = (companyId: string) =>
  JSON.stringify({
    apiBaseUrl: "https://api-na.myconnectwise.net/v4_6_release/apis/3.0",
    companyId,
    publicKey: "public-key",
    privateKey: "private-key",
    clientId: "partner-client-id",
  });

const env = {
  CONNECTWISE_ALLOWED_ORIGINS: JSON.stringify([
    "https://api-na.myconnectwise.net",
  ]),
  CW_PROFILE_LUIS: profile("company-luis"),
  CW_PROFILE_MAYA: profile("company-maya"),
};

describe("authenticated MCP transport", () => {
  it("isolates concurrent profile contexts from hostile headers and arguments", async () => {
    const selectedCompanies: string[] = [];
    const auditMessages: string[] = [];

    const call = async (profileAlias: "LUIS" | "MAYA", ticketId: number) => {
      const handler = createMcpHandler(
        () =>
          createMcpServer(env, {
            audit: {
              logger: (message) => auditMessages.push(message),
            },
            createClient: (credentials) => {
              selectedCompanies.push(credentials.companyId);
              return {
                async getServiceTicket(id) {
                  await new Promise((resolve) => setTimeout(resolve, 5));
                  return {
                    id,
                    summary: credentials.companyId,
                    status: { name: "New" },
                  };
                },
              };
            },
          }),
        {
          route: "/mcp",
          corsOptions: false,
          authContext: {
            props: { profileAlias, scopes: ["mcp:read"] },
          },
        },
      );

      const response = await handler.fetch(
        new Request("http://localhost/mcp", {
          method: "POST",
          headers: {
            Accept: "application/json, text/event-stream",
            "Content-Type": "application/json",
            Host: "localhost",
            "MCP-Protocol-Version": "2025-06-18",
            "X-CW-Profile": profileAlias === "LUIS" ? "MAYA" : "LUIS",
            "X-CW-Public-Key": "hostile-public-key",
            "X-CW-Private-Key": "hostile-private-key",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: ticketId,
            method: "tools/call",
            params: {
              name: "get_service_ticket",
              arguments: {
                ticketId,
                profileAlias: profileAlias === "LUIS" ? "MAYA" : "LUIS",
                publicKey: "hostile-public-key",
                privateKey: "hostile-private-key",
              },
            },
          }),
        }),
      );
      return { status: response.status, body: await response.text() };
    };

    const [luis, maya] = await Promise.all([call("LUIS", 1), call("MAYA", 2)]);

    expect(luis.status, luis.body).toBe(200);
    expect(maya.status, maya.body).toBe(200);
    expect(luis.body).toContain('\\"id\\":1,\\"status\\":\\"New\\"');
    expect(maya.body).toContain('\\"id\\":2,\\"status\\":\\"New\\"');
    expect(luis.body).not.toContain("company-luis");
    expect(luis.body).not.toContain("company-maya");
    expect(maya.body).not.toContain("company-maya");
    expect(maya.body).not.toContain("company-luis");
    expect(luis.body).not.toContain("hostile");
    expect(maya.body).not.toContain("hostile");
    expect(selectedCompanies.sort()).toEqual(["company-luis", "company-maya"]);

    const auditEvents = auditMessages.map((message) => JSON.parse(message));
    expect(auditEvents).toHaveLength(2);
    expect(auditEvents.map((event) => event.profileAlias).sort()).toEqual([
      "LUIS",
      "MAYA",
    ]);
    for (const event of auditEvents) {
      expect(event).toMatchObject({
        event: "mcp_tool_invocation",
        tool: "get_service_ticket",
        outcome: "success",
        reason: "ok",
      });
      expect(Object.keys(event).sort()).toEqual(
        [
          "correlationId",
          "durationMs",
          "event",
          "outcome",
          "profileAlias",
          "reason",
          "timestamp",
          "tool",
          "version",
        ].sort(),
      );
    }
    expect(auditMessages.join("\n")).not.toContain("hostile");
    expect(auditMessages.join("\n")).not.toContain("company-luis");
    expect(auditMessages.join("\n")).not.toContain("company-maya");
  });
});
