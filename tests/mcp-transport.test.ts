import { createMcpHandler } from "agents/mcp/server";
import { describe, expect, it } from "vitest";
import { createMcpServer } from "../src/mcp-server";
import {
  ConnectWiseRequestError,
  createConnectWiseClient,
  type ConnectWiseClient,
} from "../src/connectwise-client";

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
  const unusedDownload = async (): Promise<{
    base64: string;
    mimeType: string;
    byteLength: number;
  }> => {
    throw new Error("unexpected client operation");
  };
  return {
    getServiceTicket: unused,
    getTicketNotes: unused,
    getTicketAttachments: unused,
    getTicketTasks: unused,
    getTicketTimeEntries: unused,
    createTicketNote: unused,
    getServiceBoards: unused,
    getBoardStatuses: unused,
    getBoardTypes: unused,
    listBoardTickets: unused,
    getServiceStatuses: unused,
    getServicePriorities: unused,
    getServiceSources: unused,
    getMyMember: unused,
    listMembers: unused,
    searchCompanies: unused,
    searchContacts: unused,
    listTimeEntries: unused,
    listScheduleEntries: unused,
    getTimeSheets: unused,
    getDocument: unused,
    downloadDocument: unusedDownload,
    uploadImageDocument: unused,
    attachImageToTicket: unused,
    attachImageToTimeEntry: unused,
    catalogGet: unused,
    createScheduleEntry: unused,
    updateScheduleEntry: unused,
    deleteScheduleEntry: async () => undefined,
    createTimeEntry: unused,
    createServiceTicket: unused,
    updateServiceTicket: unused,
    openScheduleEntriesForObject: async () => [],
    searchServiceTickets: unused,
    getAgreement: unused,
    getAgreementAdditions: unused,
    createAgreementAddition: unused,
    getRecentAgreementInvoices: unused,
    ...overrides,
  };
}

const tinyPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const tinyPngDataUri = `data:image/png;base64,${tinyPng}`;

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
    ]) {
      expect(body).toContain(`"name":"${name}"`);
    }
    expect(body).not.toContain('"name":"execute_api_call"');
    expect(body).toContain('"readOnlyHint":false');
    expect(body).toContain('"idempotentHint":false');
    expect(body).toContain("ui://connectwise/attachment-uploader.html");
    expect(body).toContain('"visibility":["app"]');
  });

  it("denies every write tool without mcp:write before resolving a profile", async () => {
    const auditMessages: string[] = [];
    let clientCreated = false;
    const handler = createMcpHandler(
      () =>
        createMcpServer(env, {
          audit: { logger: (message) => auditMessages.push(message) },
          createBusinessClient: () => {
            clientCreated = true;
            return businessClient();
          },
        }),
      {
        route: "/mcp",
        corsOptions: false,
        authContext: {
          props: { profileAlias: "LUIS", scopes: ["mcp:read"] },
        },
      },
    );
    const writes: Array<{ name: string; arguments: Record<string, unknown> }> =
      [
        {
          name: "upload_connectwise_image",
          arguments: {
            recordType: "Ticket",
            recordId: 1,
            fileName: "test.png",
            mimeType: "image/png",
            base64: "AAAA",
          },
        },
        {
          name: "create_ticket_note",
          arguments: { ticketId: 1, text: "must not be sent" },
        },
        {
          name: "attach_image_to_ticket",
          arguments: { ticketId: 1, image: tinyPngDataUri },
        },
        {
          name: "attach_image_to_time_entry",
          arguments: { timeEntryId: 1, image: tinyPngDataUri },
        },
        {
          name: "create_agreement_addition",
          arguments: {
            agreementId: 1,
            productId: 1,
            quantity: 1,
            unitPrice: 1,
            effectiveDate: "2026-09-02",
          },
        },
        {
          name: "create_service_ticket",
          arguments: { companyId: 1, summary: "must not be sent" },
        },
        { name: "update_service_ticket", arguments: { ticketId: 1 } },
        {
          name: "create_schedule_entry",
          arguments: {
            memberId: 1,
            dateStart: "2026-09-02T10:00:00Z",
            dateEnd: "2026-09-02T11:00:00Z",
          },
        },
        { name: "update_schedule_entry", arguments: { entryId: 1 } },
        { name: "delete_schedule_entry", arguments: { entryId: 1 } },
        {
          name: "create_time_entry",
          arguments: {
            memberId: 1,
            timeStart: "2026-09-02T10:00:00Z",
            timeEnd: "2026-09-02T11:00:00Z",
          },
        },
      ];

    for (const [index, write] of writes.entries()) {
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
            id: 20 + index,
            method: "tools/call",
            params: write,
          }),
        }),
      );
      expect(await response.text(), write.name).toContain("Insufficient scope");
    }

    expect(clientCreated).toBe(false);
    expect(auditMessages).toHaveLength(writes.length);
    expect(auditMessages.map((message) => JSON.parse(message).tool)).toEqual(
      writes.map((write) => write.name),
    );
    for (const message of auditMessages) {
      expect(JSON.parse(message)).toMatchObject({
        profileAlias: "LUIS",
        outcome: "denied",
        reason: "insufficient_scope",
      });
      expect(message).not.toContain("must not be sent");
    }
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
          props: { profileAlias: "LUIS", scopes: ["mcp:read", "mcp:write"] },
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
    expect(auditMessages[0]).not.toContain('"ticketId"');
  });

  it("uploads an image through the app-only tool without echoing its bytes", async () => {
    const auditMessages: string[] = [];
    let received:
      | {
          companyId: string;
          recordType: string;
          recordId: number;
          fileName: string;
          privateFlag: boolean;
        }
      | undefined;
    const imageBase64 = btoa(
      String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    );
    const handler = createMcpHandler(
      () =>
        createMcpServer(env, {
          audit: { logger: (message) => auditMessages.push(message) },
          createBusinessClient: (credentials) =>
            businessClient({
              async uploadImageDocument(recordType, recordId, input) {
                received = {
                  companyId: credentials.companyId,
                  recordType,
                  recordId,
                  fileName: input.fileName,
                  privateFlag: input.privateFlag,
                };
                return {
                  id: 902,
                  title: input.title,
                  fileName: input.fileName,
                  imageFlag: true,
                  publicFlag: !input.privateFlag,
                  size: 8,
                };
              },
            }),
        }),
      {
        route: "/mcp",
        corsOptions: false,
        authContext: {
          props: { profileAlias: "LUIS", scopes: ["mcp:read", "mcp:write"] },
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
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 21,
          method: "tools/call",
          params: {
            name: "upload_connectwise_image",
            arguments: {
              recordType: "TimeEntry",
              recordId: 88,
              fileName: "onsite.png",
              mimeType: "image/png",
              base64: imageBase64,
              title: "Onsite photo",
              privateFlag: true,
            },
          },
        }),
      }),
    );
    const body = await response.text();
    expect(received).toEqual({
      companyId: "company-luis",
      recordType: "TimeEntry",
      recordId: 88,
      fileName: "onsite.png",
      privateFlag: true,
    });
    expect(body).toContain('\\"id\\":902');
    expect(body).toContain('\\"recordType\\":\\"TimeEntry\\"');
    expect(body).not.toContain(imageBase64);
    expect(auditMessages).toHaveLength(1);
    expect(JSON.parse(auditMessages[0]!)).toMatchObject({
      profileAlias: "LUIS",
      tool: "upload_connectwise_image",
      outcome: "success",
      reason: "ok",
    });
    expect(auditMessages[0]).not.toContain(imageBase64);
    expect(auditMessages[0]).not.toContain("onsite.png");
  });

  it("serves the inline attachment uploader as an MCP App resource", async () => {
    const handler = createMcpHandler(() => createMcpServer(env), {
      route: "/mcp",
      corsOptions: false,
      authContext: {
        props: { profileAlias: "LUIS", scopes: ["mcp:read", "mcp:write"] },
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
          id: 22,
          method: "resources/read",
          params: {
            uri: "ui://connectwise/attachment-uploader.html",
          },
        }),
      }),
    );
    const body = await response.text();
    expect(body).toContain("text/html;profile=mcp-app");
    expect(body).toContain("Drop or paste an image here");
    expect(body).toContain("upload_connectwise_image");
    expect(body).not.toContain("private-key");
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

  it("lists service boards with bounded projections", async () => {
    const handler = createMcpHandler(
      () =>
        createMcpServer(env, {
          createBusinessClient: (credentials) =>
            businessClient({
              async getServiceBoards() {
                return [
                  {
                    id: 32,
                    name: "Triage",
                    description: "New intake queue",
                    type: { id: 4, name: "Technical" },
                  },
                  {
                    id: 33,
                    name: "In Progress",
                    extra: { nested: "should-not-appear" },
                  },
                ];
              },
            }),
        }),
      {
        route: "/mcp",
        corsOptions: false,
        authContext: {
          props: { profileAlias: "LUIS", scopes: ["mcp:read", "mcp:write"] },
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
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 50,
          method: "tools/call",
          params: { name: "get_service_boards", arguments: {} },
        }),
      }),
    );
    const body = await response.text();
    expect(body).toContain('\\"id\\":32');
    expect(body).toContain('\\"name\\":\\"Triage\\"');
    expect(body).toContain('\\"type\\":{\\"id\\":4');
    expect(body).not.toContain("should-not-appear");
  });

  it("lists board tickets for the authenticated profile only", async () => {
    let received: { companyId: string; boardId: number } | undefined;
    const handler = createMcpHandler(
      () =>
        createMcpServer(env, {
          createBusinessClient: (credentials) =>
            businessClient({
              async listBoardTickets(boardId) {
                received = { companyId: credentials.companyId, boardId };
                return [
                  {
                    id: 910,
                    summary: "Printer on fire",
                    board: { id: 32, name: "Triage" },
                    status: { id: 547, name: "New" },
                    company: { id: 250, name: "FUNCSHUN" },
                  },
                ];
              },
            }),
        }),
      {
        route: "/mcp",
        corsOptions: false,
        authContext: {
          props: { profileAlias: "LUIS", scopes: ["mcp:read", "mcp:write"] },
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
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 51,
          method: "tools/call",
          params: {
            name: "list_board_tickets",
            arguments: { boardId: 32 },
          },
        }),
      }),
    );
    expect(received).toEqual({ companyId: "company-luis", boardId: 32 });
    const body = await response.text();
    expect(body).toContain('\\"id\\":910');
    expect(body).toContain('\\"board\\":{\\"id\\":32');
  });

  it("runs the read-only catalog with allowlisted routes and parameters", async () => {
    const calls: Array<{ route: string; params: Record<string, unknown> }> = [];
    const handler = createMcpHandler(
      () =>
        createMcpServer(env, {
          createBusinessClient: (credentials) =>
            businessClient({
              async catalogGet(route, params) {
                calls.push({ route, params });
                if (route === "service.tickets.byStatus") {
                  return [
                    {
                      id: 911,
                      summary: "Router dead",
                      status: { id: 547, name: "New" },
                    },
                  ];
                }
                if (route === "service.tickets.byOwner") {
                  return [
                    {
                      id: 912,
                      summary: "Closed router ticket",
                      owner: { id: 149, name: "Luis" },
                      closedFlag: true,
                      closedDate: "2026-08-29T18:00:00Z",
                      dateResolved: "2026-08-29T17:45:00Z",
                    },
                  ];
                }
                return [
                  {
                    id: 400,
                    title: "Onsite Log.pdf",
                    fileName: "Onsite Log.pdf",
                    size: 123456,
                    password: "must-not-escape",
                    privateKey: "must-not-escape",
                    unexpected: "must-not-escape",
                  },
                ];
              },
            }),
        }),
      {
        route: "/mcp",
        corsOptions: false,
        authContext: {
          props: { profileAlias: "LUIS", scopes: ["mcp:read", "mcp:write"] },
        },
      },
    );
    const first = await handler.fetch(
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
          id: 52,
          method: "tools/call",
          params: {
            name: "call_connectwise",
            arguments: { route: "service.tickets.byStatus", statusId: 547 },
          },
        }),
      }),
    );
    const firstBody = await first.text();
    expect(calls[0]).toEqual({
      route: "service.tickets.byStatus",
      params: { pageSize: 20, statusId: 547 },
    });
    expect(firstBody).toContain('\\"id\\":911');

    const second = await handler.fetch(
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
          id: 53,
          method: "tools/call",
          params: {
            name: "call_connectwise",
            arguments: {
              route: "system.documents",
              recordType: "Ticket",
              recordId: 77,
            },
          },
        }),
      }),
    );
    const secondBody = await second.text();
    expect(calls[1]?.params).toEqual(
      expect.objectContaining({
        recordType: "Ticket",
        recordId: 77,
      }),
    );
    expect(secondBody).toContain('\\"fileName\\":\\"Onsite Log.pdf\\"');
    expect(secondBody).not.toContain("must-not-escape");
    expect(secondBody).not.toContain("password");
    expect(secondBody).not.toContain("privateKey");
    expect(secondBody).not.toContain("unexpected");

    const third = await handler.fetch(
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
          id: 531,
          method: "tools/call",
          params: {
            name: "call_connectwise",
            arguments: {
              route: "service.tickets.byOwner",
              memberId: 149,
              includeClosed: "true",
            },
          },
        }),
      }),
    );
    const thirdBody = await third.text();
    expect(calls[2]).toEqual({
      route: "service.tickets.byOwner",
      params: { pageSize: 20, memberId: 149, includeClosed: "true" },
    });
    expect(thirdBody).toContain('\\"closedFlag\\":true');
    expect(thirdBody).toContain(
      '\\"dateResolved\\":\\"2026-08-29T17:45:00Z\\"',
    );
  });

  it("does not expose upstream response bodies or internal errors", async () => {
    const errors: unknown[] = [
      new ConnectWiseRequestError(400, {
        method: "GET",
        path: "/company/configurations",
        bodyPreview:
          '{"privateKey":"secret value with spaces","token":"short"}',
      }),
      new Error("CW_PROFILE_LUIS contains private-key and secret value"),
      new Error("secret value explicit timezone offset privateKey"),
      new Error("secret value timesheet is pending approval privateKey"),
      new Error("statusId 1 is not valid on board 2; secret value privateKey"),
    ];

    for (const [index, error] of errors.entries()) {
      const handler = createMcpHandler(
        () =>
          createMcpServer(env, {
            createBusinessClient: () =>
              businessClient({
                async catalogGet() {
                  throw error;
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
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 540 + index,
            method: "tools/call",
            params: {
              name: "call_connectwise",
              arguments: {
                route: "company.configurations",
                query: "router",
              },
            },
          }),
        }),
      );
      const body = await response.text();
      expect(body).not.toContain("secret value");
      expect(body).not.toContain("privateKey");
      expect(body).not.toContain("CW_PROFILE_LUIS");
      expect(body).not.toContain("/company/configurations");
    }
  });

  it("downloads a document as bounded base64", async () => {
    let received: { companyId: string; documentId: number } | undefined;
    const handler = createMcpHandler(
      () =>
        createMcpServer(env, {
          createBusinessClient: (credentials) =>
            businessClient({
              async downloadDocument(documentId) {
                received = { companyId: credentials.companyId, documentId };
                return {
                  base64: "QUJD",
                  mimeType: "application/pdf",
                  byteLength: 3,
                };
              },
            }),
        }),
      {
        route: "/mcp",
        corsOptions: false,
        authContext: {
          props: { profileAlias: "LUIS", scopes: ["mcp:read", "mcp:write"] },
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
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 54,
          method: "tools/call",
          params: {
            name: "download_document",
            arguments: { documentId: 400 },
          },
        }),
      }),
    );
    expect(received).toEqual({ companyId: "company-luis", documentId: 400 });
    const body = await response.text();
    expect(body).toContain('\\"base64\\":\\"QUJD\\"');
    expect(body).toContain('\\"mimeType\\":\\"application/pdf\\"');
  });

  it("searches companies and contacts with bounded projections", async () => {
    const handler = createMcpHandler(
      () =>
        createMcpServer(env, {
          createBusinessClient: (credentials) =>
            businessClient({
              async searchCompanies(query, pageSize) {
                return [{ id: 250, name: "FUNCSHUN", phone: "555-0100" }];
              },
              async searchContacts(query, pageSize) {
                return [
                  {
                    id: 81,
                    name: "Luis Rivera",
                    email: "luis@funcshun.com",
                    company: { id: 250, name: "FUNCSHUN" },
                  },
                ];
              },
            }),
        }),
      {
        route: "/mcp",
        corsOptions: false,
        authContext: {
          props: { profileAlias: "LUIS", scopes: ["mcp:read", "mcp:write"] },
        },
      },
    );
    const companies = await handler.fetch(
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
          id: 55,
          method: "tools/call",
          params: {
            name: "search_companies",
            arguments: { query: "FUNC" },
          },
        }),
      }),
    );
    const companyBody = await companies.text();
    expect(companyBody).toContain('\\"id\\":250');
    expect(companyBody).toContain('\\"name\\":\\"FUNCSHUN\\"');

    const contacts = await handler.fetch(
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
          id: 56,
          method: "tools/call",
          params: {
            name: "search_contacts",
            arguments: { query: "luis" },
          },
        }),
      }),
    );
    const contactBody = await contacts.text();
    expect(contactBody).toContain('\\"id\\":81');
  });

  it("returns the authenticated member record for get_my_member", async () => {
    let received: { companyId: string } | undefined;
    const handler = createMcpHandler(
      () =>
        createMcpServer(env, {
          createBusinessClient: (credentials) => {
            received = { companyId: credentials.companyId };
            return businessClient({
              async getMyMember() {
                return {
                  id: 149,
                  firstName: "Luis",
                  lastName: "Rivera",
                  email: "luis@funcshun.com",
                  status: { id: 1, name: "Active" },
                };
              },
            });
          },
        }),
      {
        route: "/mcp",
        corsOptions: false,
        authContext: {
          props: { profileAlias: "LUIS", scopes: ["mcp:read", "mcp:write"] },
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
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 57,
          method: "tools/call",
          params: { name: "get_my_member", arguments: {} },
        }),
      }),
    );
    expect(received).toEqual({ companyId: "company-luis" });
    const body = await response.text();
    expect(body).toContain('\\"id\\":149');
  });

  // Phase 2 write tools must be exercised through the MCP tool interface with
  // the exact JSON arguments a client sends (third occurrence of the
  // wrong-layer test: mocks/curl passed while the tool handler failed).
  it("create_schedule_entry converts offset to second-precision UTC on the wire", async () => {
    const bodies: Array<{ method: string; url: string; body?: unknown }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const method = (init as { method?: string } | undefined)?.method ?? "GET";
      const rawBody = (init as { body?: string } | undefined)?.body;
      bodies.push({
        method,
        url: String(input),
        ...(rawBody ? { body: JSON.parse(rawBody) } : {}),
      });
      return Response.json({
        id: 9001,
        member: { id: 149 },
        dateStart: "2026-08-31T12:30:00Z",
        dateEnd: "2026-08-31T21:00:00Z",
        status: { id: 1 },
      });
    };
    const handler = createMcpHandler(
      () =>
        createMcpServer(env, {
          createBusinessClient: (credentials) =>
            createConnectWiseClient(credentials, { fetcher }),
        }),
      {
        route: "/mcp",
        corsOptions: false,
        authContext: {
          props: { profileAlias: "LUIS", scopes: ["mcp:read", "mcp:write"] },
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
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "create_schedule_entry",
            arguments: {
              memberId: 149,
              objectId: 1892065,
              objectType: 4,
              statusId: 1,
              dateStart: "2026-08-31T08:30:00-04:00",
              dateEnd: "2026-08-31T17:00:00-04:00",
            },
          },
        }),
      }),
    );
    const text = await response.text();
    const post = bodies.find(
      (b) => b.method === "POST" && b.url.endsWith("/schedule/entries"),
    )!;
    expect(post).toBeDefined();
    const wire = post.body as Record<string, unknown>;
    // CW rejects fractional seconds; must be second precision on the wire.
    expect(wire.dateStart).toBe("2026-08-31T12:30:00Z");
    expect(wire.dateEnd).toBe("2026-08-31T21:00:00Z");
    expect((wire.member as { id: number }).id).toBe(149);
    expect((wire.type as { id: number }).id).toBe(4);
    expect(text).toContain('\\"id\\":9001');
  });

  it("create_schedule_entry rejects a bare local time without a fetch", async () => {
    let requests = 0;
    const fetcher: typeof fetch = async (_input, _init) => {
      requests += 1;
      return Response.json({});
    };
    const handler = createMcpHandler(
      () =>
        createMcpServer(env, {
          createBusinessClient: (credentials) =>
            createConnectWiseClient(credentials, { fetcher }),
        }),
      {
        route: "/mcp",
        corsOptions: false,
        authContext: {
          props: { profileAlias: "LUIS", scopes: ["mcp:read", "mcp:write"] },
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
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "create_schedule_entry",
            arguments: {
              memberId: 149,
              objectId: 1892065,
              objectType: 4,
              dateStart: "2026-08-31T12:30:00",
              dateEnd: "2026-08-31T17:00:00",
            },
          },
        }),
      }),
    );
    const text = await response.text();
    expect(text).toContain("explicit timezone offset");
    expect(requests).toBe(0);
  });

  it("update_schedule_entry merges over GET and preserves unpassed fields", async () => {
    const bodies: Array<{ method: string; url: string; body?: unknown }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const method = (init as { method?: string } | undefined)?.method ?? "GET";
      const rawBody = (init as { body?: string } | undefined)?.body;
      bodies.push({
        method,
        url: String(input),
        ...(rawBody ? { body: JSON.parse(rawBody) } : {}),
      });
      if (method === "GET" && String(input).includes("/schedule/entries/9")) {
        return Response.json({
          id: 9,
          member: { id: 149 },
          objectId: 1892065,
          type: { id: 4 },
          status: { id: 1 },
          dateStart: "2026-08-31T12:30:00Z",
          dateEnd: "2026-08-31T21:00:00Z",
          name: "Keep me",
          doneFlag: false,
        });
      }
      return Response.json({
        id: 9,
        dateEnd: "2026-08-31T22:00:00Z",
        privateKey: "UPSTREAM_PRIVATE_VALUE",
      });
    };
    const handler = createMcpHandler(
      () =>
        createMcpServer(env, {
          createBusinessClient: (credentials) =>
            createConnectWiseClient(credentials, { fetcher }),
        }),
      {
        route: "/mcp",
        corsOptions: false,
        authContext: {
          props: { profileAlias: "LUIS", scopes: ["mcp:read", "mcp:write"] },
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
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "update_schedule_entry",
            arguments: {
              entryId: 9,
              dateEnd: "2026-08-31T18:00:00-04:00",
            },
          },
        }),
      }),
    );
    const text = await response.text();
    const put = bodies.find((b) => b.method === "PUT")!;
    expect(put).toBeDefined();
    const wire = put.body as Record<string, unknown>;
    expect(wire.dateEnd).toBe("2026-08-31T22:00:00Z");
    expect(wire.dateStart).toBe("2026-08-31T12:30:00Z");
    expect(wire.name).toBe("Keep me");
    expect((wire.member as { id: number }).id).toBe(149);
    expect((wire.type as { id: number }).id).toBe(4);
    expect(text).toContain('\\"end\\":\\"2026-08-31T22:00:00Z\\"');
    expect(text).not.toContain("UPSTREAM_PRIVATE_VALUE");
    expect(text).not.toContain("privateKey");
  });

  it("delete_schedule_entry issues DELETE through the tool", async () => {
    const calls: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      calls.push(
        `${(init as { method?: string } | undefined)?.method ?? "GET"} ${String(input)}`,
      );
      return new Response(null, { status: 204 });
    };
    const handler = createMcpHandler(
      () =>
        createMcpServer(env, {
          createBusinessClient: (credentials) =>
            createConnectWiseClient(credentials, { fetcher }),
        }),
      {
        route: "/mcp",
        corsOptions: false,
        authContext: {
          props: { profileAlias: "LUIS", scopes: ["mcp:read", "mcp:write"] },
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
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "delete_schedule_entry",
            arguments: { entryId: 247134 },
          },
        }),
      }),
    );
    await response.text();
    expect(calls[0]).toBe(
      "DELETE https://api-na.myconnectwise.net/v4_6_release/apis/3.0/schedule/entries/247134",
    );
  });

  it("create_time_entry surfaces a locked timesheet message through the tool", async () => {
    const bodies: Array<{ method: string; url: string }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const method = (init as { method?: string } | undefined)?.method ?? "GET";
      bodies.push({ method, url: String(input) });
      if (String(input).includes("/time/sheets")) {
        return Response.json([
          { id: 99, status: "PendingApproval", period: 43 },
        ]);
      }
      return Response.json({ id: 1 });
    };
    const handler = createMcpHandler(
      () =>
        createMcpServer(env, {
          createBusinessClient: (credentials) =>
            createConnectWiseClient(credentials, { fetcher }),
        }),
      {
        route: "/mcp",
        corsOptions: false,
        authContext: {
          props: { profileAlias: "LUIS", scopes: ["mcp:read", "mcp:write"] },
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
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "create_time_entry",
            arguments: {
              memberId: 149,
              timeStart: "2026-09-01T12:00:00-04:00",
              timeEnd: "2026-09-01T13:00:00-04:00",
            },
          },
        }),
      }),
    );
    const text = await response.text();
    expect(text).toContain("pending approval");
    expect(bodies.filter((b) => b.method === "POST").length).toBe(0);
  });

  it("create_service_ticket posts the ticket body through the tool", async () => {
    const bodies: Array<{ method: string; url: string; body?: unknown }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const method = (init as { method?: string } | undefined)?.method ?? "GET";
      const rawBody = (init as { body?: string } | undefined)?.body;
      bodies.push({
        method,
        url: String(input),
        ...(rawBody ? { body: JSON.parse(rawBody) } : {}),
      });
      if (method === "POST" && String(input).endsWith("/service/tickets")) {
        return Response.json({
          id: 7001,
          summary: "Daily Server Backup Audit",
          company: { id: 250 },
          board: { id: 32, name: "Triage" },
          status: { id: 547, name: "New" },
          customFields: [{ value: "UPSTREAM_PRIVATE_VALUE" }],
          privateKey: "UPSTREAM_PRIVATE_VALUE",
        });
      }
      return Response.json({});
    };
    const handler = createMcpHandler(
      () =>
        createMcpServer(env, {
          createBusinessClient: (credentials) =>
            createConnectWiseClient(credentials, { fetcher }),
        }),
      {
        route: "/mcp",
        corsOptions: false,
        authContext: {
          props: { profileAlias: "LUIS", scopes: ["mcp:read", "mcp:write"] },
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
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "create_service_ticket",
            arguments: {
              companyId: 250,
              summary: "Daily Server Backup Audit",
              ownerId: 212,
            },
          },
        }),
      }),
    );
    const text = await response.text();
    const post = bodies.find(
      (b) => b.method === "POST" && b.url.endsWith("/service/tickets"),
    )!;
    expect(post).toBeDefined();
    const wire = post.body as Record<string, unknown>;
    expect((wire.company as { id: number }).id).toBe(250);
    expect(wire.summary).toBe("Daily Server Backup Audit");
    expect((wire.board as { id: number }).id).toBe(32);
    expect((wire.status as { id: number }).id).toBe(547);
    expect((wire.owner as { id: number }).id).toBe(212);
    expect(text).toContain('\\"id\\":7001');
    expect(text).not.toContain("UPSTREAM_PRIVATE_VALUE");
    expect(text).not.toContain("customFields");
    expect(text).not.toContain("privateKey");
  });

  it("update_service_ticket merges over GET and preserves unpassed fields", async () => {
    const bodies: Array<{ method: string; url: string; body?: unknown }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const method = (init as { method?: string } | undefined)?.method ?? "GET";
      const rawBody = (init as { body?: string } | undefined)?.body;
      bodies.push({
        method,
        url: String(input),
        ...(rawBody ? { body: JSON.parse(rawBody) } : {}),
      });
      if (
        method === "GET" &&
        String(input).includes("/service/tickets/1927659")
      ) {
        return Response.json({
          id: 1927659,
          summary: "Daily Server Backup Audit ",
          recordType: "ServiceTicket",
          board: { id: 64, name: "Backups - Management" },
          status: { id: 935, name: "Scheduled" },
          company: { id: 250, name: "FUNCSHUN" },
          owner: { id: 266, name: "Juan Arango" },
          priority: { id: 7 },
          type: null,
          closedFlag: false,
          _info: { dateEntered: "2026-08-27T12:00:00Z" },
        });
      }
      return Response.json({
        id: 1927659,
        privateKey: "UPSTREAM_PRIVATE_VALUE",
        customFields: [{ value: "UPSTREAM_PRIVATE_VALUE" }],
      });
    };
    const handler = createMcpHandler(
      () =>
        createMcpServer(env, {
          createBusinessClient: (credentials) =>
            createConnectWiseClient(credentials, { fetcher }),
        }),
      {
        route: "/mcp",
        corsOptions: false,
        authContext: {
          props: { profileAlias: "LUIS", scopes: ["mcp:read", "mcp:write"] },
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
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "update_service_ticket",
            arguments: { ticketId: 1927659, ownerId: 212 },
          },
        }),
      }),
    );
    const text = await response.text();
    const put = bodies.find(
      (b) => b.method === "PUT" && b.url.includes("/service/tickets/1927659"),
    )!;
    expect(put).toBeDefined();
    const wire = put.body as Record<string, unknown>;
    expect((wire.owner as { id: number }).id).toBe(212);
    // unpassed fields preserved
    expect((wire.board as { id: number }).id).toBe(64);
    expect((wire.summary as string).trim()).toBe("Daily Server Backup Audit");
    expect((wire.company as { id: number }).id).toBe(250);
    // read-only/system fields stripped
    expect(wire.id).toBeUndefined();
    expect(wire._info).toBeUndefined();
    expect(wire.recordType).toBeUndefined();
    expect(text).toContain('\\"id\\":1927659');
    expect(text).not.toContain("UPSTREAM_PRIVATE_VALUE");
    expect(text).not.toContain("customFields");
    expect(text).not.toContain("privateKey");
  });

  it("update_service_ticket rejects a status not valid on the target board", async () => {
    let puts = 0;
    const fetcher: typeof fetch = async (input, init) => {
      const method = (init as { method?: string } | undefined)?.method ?? "GET";
      if (
        method === "GET" &&
        String(input).includes("/service/boards/64/statuses")
      ) {
        return Response.json([
          { id: 921, name: "In Progress~" },
          { id: 935, name: "Scheduled" },
          { id: 955, name: ">Closed" },
        ]);
      }
      if (
        method === "GET" &&
        String(input).includes("/service/tickets/1927659")
      ) {
        return Response.json({ id: 1927659, board: { id: 64 } });
      }
      if (method === "PUT") puts += 1;
      return Response.json({ id: 1927659 });
    };
    const handler = createMcpHandler(
      () =>
        createMcpServer(env, {
          createBusinessClient: (credentials) =>
            createConnectWiseClient(credentials, { fetcher }),
        }),
      {
        route: "/mcp",
        corsOptions: false,
        authContext: {
          props: { profileAlias: "LUIS", scopes: ["mcp:read", "mcp:write"] },
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
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "update_service_ticket",
            arguments: { ticketId: 1927659, boardId: 64, statusId: 547 },
          },
        }),
      }),
    );
    const text = await response.text();
    expect(text).toContain("selected status is not valid");
    expect(text).not.toContain("921");
    expect(text).not.toContain("935");
    expect(puts).toBe(0);
  });

  it("update_service_ticket allows a status valid on the target board", async () => {
    let puts = 0;
    const fetcher: typeof fetch = async (input, init) => {
      const method = (init as { method?: string } | undefined)?.method ?? "GET";
      if (
        method === "GET" &&
        String(input).includes("/service/boards/64/statuses")
      ) {
        return Response.json([
          { id: 921, name: "In Progress~" },
          { id: 935, name: "Scheduled" },
        ]);
      }
      if (
        method === "GET" &&
        String(input).includes("/service/tickets/1927659")
      ) {
        return Response.json({ id: 1927659, board: { id: 64 } });
      }
      if (method === "PUT") {
        puts += 1;
        return Response.json({ id: 1927659, owner: { id: 212 } });
      }
      return Response.json({});
    };
    const handler = createMcpHandler(
      () =>
        createMcpServer(env, {
          createBusinessClient: (credentials) =>
            createConnectWiseClient(credentials, { fetcher }),
        }),
      {
        route: "/mcp",
        corsOptions: false,
        authContext: {
          props: { profileAlias: "LUIS", scopes: ["mcp:read", "mcp:write"] },
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
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "update_service_ticket",
            arguments: { ticketId: 1927659, boardId: 64, statusId: 935 },
          },
        }),
      }),
    );
    await response.text();
    expect(puts).toBe(1);
  });

  it("update_service_ticket removes board-move ghosts and reports it", async () => {
    const bodies: Array<{ method: string; url: string }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const method = (init as { method?: string } | undefined)?.method ?? "GET";
      bodies.push({ method, url: String(input) });
      if (
        method === "GET" &&
        String(input).includes("/service/tickets/1927963")
      ) {
        return Response.json({
          id: 1927963,
          summary: "Scratch",
          board: { id: 32 },
          status: { id: 547 },
          company: { id: 250 },
          _info: {},
        });
      }
      if (
        method === "GET" &&
        String(input).includes("/service/boards/64/statuses")
      ) {
        return Response.json([
          { id: 935, name: "Scheduled" },
          { id: 921, name: "In Progress~" },
        ]);
      }
      if (method === "PUT") {
        return Response.json({ id: 1927963, board: { id: 64 } });
      }
      if (
        method === "GET" &&
        String(input).includes("/schedule/entries") &&
        String(input).includes("objectId")
      ) {
        return Response.json([
          {
            id: 247139,
            dateStart: "2026-09-03T00:00:00Z",
            dateEnd: "2026-09-03T00:00:00Z",
            hours: 0,
          },
        ]);
      }
      if (method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return Response.json([]);
    };
    const handler = createMcpHandler(
      () =>
        createMcpServer(env, {
          createBusinessClient: (credentials) =>
            createConnectWiseClient(credentials, { fetcher }),
        }),
      {
        route: "/mcp",
        corsOptions: false,
        authContext: {
          props: { profileAlias: "LUIS", scopes: ["mcp:read", "mcp:write"] },
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
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "update_service_ticket",
            arguments: { ticketId: 1927963, boardId: 64, statusId: 935 },
          },
        }),
      }),
    );
    const text = await response.text();
    expect(bodies.filter((b) => b.method === "PUT").length).toBe(1);
    expect(bodies.filter((b) => b.method === "DELETE").length).toBe(1);
    expect(text).toContain("247139");
    expect(text).toContain("ghost");
  });

  it("whereId reaches the schedule create/update wire body", async () => {
    const bodies: Array<{ method: string; url: string; body?: unknown }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const method = (init as { method?: string } | undefined)?.method ?? "GET";
      const rawBody = (init as { body?: string } | undefined)?.body;
      bodies.push({
        method,
        url: String(input),
        ...(rawBody ? { body: JSON.parse(rawBody) } : {}),
      });
      if (method === "POST" && String(input).endsWith("/schedule/entries")) {
        return Response.json({ id: 100, dateStart: "2026-09-01T12:00:00Z" });
      }
      if (method === "GET" && String(input).includes("/schedule/entries/100")) {
        return Response.json({
          id: 100,
          member: { id: 149 },
          dateStart: "2026-09-01T12:00:00Z",
          where: { id: 4 },
        });
      }
      return Response.json({ id: 100, where: { id: 2 } });
    };
    const handler = createMcpHandler(
      () =>
        createMcpServer(env, {
          createBusinessClient: (credentials) =>
            createConnectWiseClient(credentials, { fetcher }),
        }),
      {
        route: "/mcp",
        corsOptions: false,
        authContext: {
          props: { profileAlias: "LUIS", scopes: ["mcp:read", "mcp:write"] },
        },
      },
    );
    const create = await handler.fetch(
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
          method: "tools/call",
          params: {
            name: "create_schedule_entry",
            arguments: {
              memberId: 149,
              objectId: 1927351,
              objectType: 4,
              dateStart: "2026-09-01T08:00:00-04:00",
              dateEnd: "2026-09-01T09:00:00-04:00",
              whereId: 2,
            },
          },
        }),
      }),
    );
    await create.text();
    const createPost = bodies.find(
      (b) => b.method === "POST" && b.url.endsWith("/schedule/entries"),
    )!;
    expect((createPost.body as Record<string, unknown>).where).toEqual({
      id: 2,
    });

    const update = await handler.fetch(
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
          id: 2,
          method: "tools/call",
          params: {
            name: "update_schedule_entry",
            arguments: { entryId: 100, whereId: 2 },
          },
        }),
      }),
    );
    await update.text();
    const put = bodies.find((b) => b.method === "PUT")!;
    expect((put.body as Record<string, unknown>).where).toEqual({ id: 2 });
  });

  it("attaches a chat image to a ticket with only the authenticated user's profile", async () => {
    let received:
      { companyId: string; ticketId: number; attachment: object } | undefined;
    const handler = createMcpHandler(
      () =>
        createMcpServer(env, {
          createBusinessClient: (credentials) =>
            businessClient({
              async attachImageToTicket(ticketId, attachment) {
                received = {
                  companyId: credentials.companyId,
                  ticketId,
                  attachment,
                };
                return {
                  id: 55,
                  url: "https://na.myconnectwise.net/documents/55/contents",
                  size: 68,
                };
              },
            }),
        }),
      {
        route: "/mcp",
        corsOptions: false,
        authContext: {
          props: { profileAlias: "LUIS", scopes: ["mcp:read", "mcp:write"] },
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
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "attach_image_to_ticket",
            arguments: {
              ticketId: 77,
              image: tinyPngDataUri,
              filename: "shot.png",
            },
          },
        }),
      }),
    );
    const body = await response.text();
    expect(received).toEqual({
      companyId: "company-luis",
      ticketId: 77,
      attachment: {
        filename: "shot.png",
        base64: tinyPng,
        mimeType: "image/png",
      },
    });
    expect(body).toContain('\\"id\\":55');
    expect(body).toContain('\\"filename\\":\\"shot.png\\"');
  });

  it("attaches a chat image to a time entry and falls back to a generated filename", async () => {
    let received:
      | { companyId: string; timeEntryId: number; attachment: object }
      | undefined;
    const handler = createMcpHandler(
      () =>
        createMcpServer(env, {
          createBusinessClient: (credentials) =>
            businessClient({
              async attachImageToTimeEntry(timeEntryId, attachment) {
                received = {
                  companyId: credentials.companyId,
                  timeEntryId,
                  attachment,
                };
                return {
                  id: 66,
                  url: "https://na.myconnectwise.net/documents/66/contents",
                };
              },
            }),
        }),
      {
        route: "/mcp",
        corsOptions: false,
        authContext: {
          props: { profileAlias: "MAYA", scopes: ["mcp:read", "mcp:write"] },
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
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: {
            name: "attach_image_to_time_entry",
            arguments: {
              timeEntryId: 42,
              image: tinyPngDataUri,
              filename: "../../etc/passwd",
            },
          },
        }),
      }),
    );
    const body = await response.text();
    expect(received).toEqual({
      companyId: "company-maya",
      timeEntryId: 42,
      attachment: {
        filename: "image.png",
        base64: tinyPng,
        mimeType: "image/png",
      },
    });
    expect(body).toContain('\\"id\\":66');
    expect(body).not.toContain("passwd");
  });

  it("inlines a chat image in a ticket note after attaching it to the ticket", async () => {
    const calls: string[] = [];
    const handler = createMcpHandler(
      () =>
        createMcpServer(env, {
          createBusinessClient: (credentials) =>
            businessClient({
              async attachImageToTicket(_ticketId, _attachment) {
                calls.push(`attach:${credentials.companyId}`);
                return {
                  id: 71,
                  url: "https://na.myconnectwise.net/documents/71/contents?token=abc&x=1",
                };
              },
              async createTicketNote(ticketId, note) {
                calls.push(`note:${ticketId}:${note.text}`);
                return { id: 92 };
              },
            }),
        }),
      {
        route: "/mcp",
        corsOptions: false,
        authContext: {
          props: { profileAlias: "LUIS", scopes: ["mcp:read", "mcp:write"] },
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
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: {
            name: "create_ticket_note",
            arguments: {
              ticketId: 77,
              text: "See the screenshot below.",
              image: tinyPngDataUri,
            },
          },
        }),
      }),
    );
    const body = await response.text();
    expect(calls[0]).toBe("attach:company-luis");
    expect(calls[1]).toBe(
      'note:77:See the screenshot below.\n<img src="https://na.myconnectwise.net/documents/71/contents?token=abc&amp;x=1">',
    );
    expect(body).toContain('\\"id\\":92');
    expect(body).toContain('imageAttached\\":true');
  });

  it("rejects non-image and oversized image payloads before any ConnectWise call", async () => {
    let attachCalls = 0;
    const handler = createMcpHandler(
      () =>
        createMcpServer(env, {
          createBusinessClient: () =>
            businessClient({
              async attachImageToTicket() {
                attachCalls += 1;
                return { id: 1 };
              },
            }),
        }),
      {
        route: "/mcp",
        corsOptions: false,
        authContext: {
          props: { profileAlias: "LUIS", scopes: ["mcp:read", "mcp:write"] },
        },
      },
    );
    const post = async (id: number, imageValue: string) => {
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
            id,
            method: "tools/call",
            params: {
              name: "attach_image_to_ticket",
              arguments: { ticketId: 77, image: imageValue },
            },
          }),
        }),
      );
      return { status: response.status, body: await response.text() };
    };

    const badType = await post(6, "data:text/plain;base64,SGVsbG8=");
    const oversized = await post(
      7,
      `data:image/png;base64,${"A".repeat(14_000_000)}`,
    );
    expect(badType.body).toContain("image data URI");
    expect(oversized.body).toContain("image data URI");
    expect(badType.body).not.toContain('\\"id\\":1');
    expect(attachCalls).toBe(0);
  });
});
