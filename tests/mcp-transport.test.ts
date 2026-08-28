import { createMcpHandler } from "agents/mcp/server";
import { describe, expect, it } from "vitest";
import { createMcpServer } from "../src/mcp-server";
import type { ConnectWiseClient } from "../src/connectwise-client";

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

function businessClient(
  overrides: Partial<ConnectWiseClient> = {},
): ConnectWiseClient {
  const unused = async (): Promise<unknown> => {
    throw new Error("unexpected client operation");
  };
  return {
    getServiceTicket: unused,
    getTicketNotes: unused,
    getTicketAttachments: unused,
    getTicketTasks: unused,
    getTicketTimeEntries: unused,
    createTicketNote: unused,
    searchServiceTickets: unused,
    getAgreement: unused,
    getAgreementAdditions: unused,
    createAgreementAddition: unused,
    getRecentAgreementInvoices: unused,
    ...overrides,
  };
}

describe("authenticated MCP transport", () => {
  it("advertises the complete bounded business-tool catalog", async () => {
    const handler = createMcpHandler(() => createMcpServer(env), {
      route: "/mcp",
      corsOptions: false,
      authContext: {
        props: { profileAlias: "LUIS", scopes: ["mcp:read"] },
      },
    });
    const response = await handler.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
          Host: "localhost",
          "MCP-Protocol-Version": "2025-06-18",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      }),
    );
    const body = await response.text();
    for (const name of [
      "whoami",
      "get_service_ticket",
      "search_tickets_by_content",
      "get_ticket_notes_with_content",
      "get_ticket_attachments_with_details",
      "get_complete_ticket_content",
      "create_ticket_note",
      "get_agreement_additions",
      "get_agreement_additions_summary",
      "create_agreement_addition",
      "search_agreement_additions",
      "get_agreement_billing_summary",
    ]) {
      expect(body).toContain(`"name":"${name}"`);
    }
    expect(body).toContain('"readOnlyHint":false');
    expect(body).toContain('"idempotentHint":false');
  });

  it("executes a write with only the authenticated user's ConnectWise profile", async () => {
    const auditMessages: string[] = [];
    let received:
      | {
          companyId: string;
          ticketId: number;
          note: {
            text: string;
            internalOnly: boolean;
            resolutionNote: boolean;
            issueNote: boolean;
          };
        }
      | undefined;
    const handler = createMcpHandler(
      () =>
        createMcpServer(env, {
          audit: { logger: (message) => auditMessages.push(message) },
          createBusinessClient: (credentials) =>
            businessClient({
              async createTicketNote(ticketId, note) {
                received = {
                  companyId: credentials.companyId,
                  ticketId,
                  note,
                };
                return { id: 91, text: "must not escape" };
              },
            }),
        }),
      {
        route: "/mcp",
        corsOptions: false,
        authContext: {
          props: { profileAlias: "LUIS", scopes: ["mcp:read"] },
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
          "X-CW-Profile": "MAYA",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "create_ticket_note",
            arguments: {
              ticketId: 77,
              text: "Approved staging note",
              internalOnly: true,
              profileAlias: "MAYA",
            },
          },
        }),
      }),
    );
    const body = await response.text();
    expect(received).toEqual({
      companyId: "company-luis",
      ticketId: 77,
      note: {
        text: "Approved staging note",
        internalOnly: true,
        resolutionNote: false,
        issueNote: false,
      },
    });
    expect(body).toContain('\\"id\\":91');
    expect(body).not.toContain("Approved staging note");
    expect(body).not.toContain("must not escape");
    expect(auditMessages).toHaveLength(1);
    expect(JSON.parse(auditMessages[0]!)).toMatchObject({
      profileAlias: "LUIS",
      tool: "create_ticket_note",
      outcome: "success",
      reason: "ok",
    });
    expect(auditMessages[0]).not.toContain("Approved staging note");
    expect(auditMessages[0]).not.toContain("77");
  });

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
