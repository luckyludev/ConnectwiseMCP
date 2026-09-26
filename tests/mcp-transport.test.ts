import { createMcpHandler } from "agents/mcp/server";
import { describe, expect, it } from "vitest";
import { createMcpServer } from "../src/mcp-server";
import { TOOL_ACCESS } from "../src/tool-access";
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
    memberId: 149,
  });

const env = {
  CONNECTWISE_ALLOWED_ORIGINS: JSON.stringify([
    "https://api-na.myconnectwise.net",
  ]),
  CW_PROFILE_LUIS: profile("company-luis"),
  CW_PROFILE_MAYA: profile("company-maya"),
};

function parseSseJsonRpcResponse(
  eventStream: string,
  expectedId: number,
): unknown {
  for (const event of eventStream.replaceAll("\r\n", "\n").split("\n\n")) {
    const data = event
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).replace(/^ /, ""))
      .join("\n");
    if (!data || data === "[DONE]") continue;
    try {
      const message = JSON.parse(data) as { id?: unknown };
      if (message.id === expectedId) return message;
    } catch {
      // Ignore non-JSON events and keep looking for the requested response.
    }
  }
  throw new Error(`Missing JSON-RPC response for id ${expectedId}`);
}

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
    searchMembers: unused,
    searchCompanies: unused,
    searchContacts: unused,
    listTimeEntries: unused,
    listScheduleEntries: unused,
    getTimeSheets: unused,
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
    const eventStream = await response.text();
    const body = parseSseJsonRpcResponse(eventStream, 1) as {
      result: {
        tools: Array<{
          name: string;
          inputSchema?: { properties?: Record<string, unknown> };
          annotations?: {
            readOnlyHint?: boolean;
            destructiveHint?: boolean;
            idempotentHint?: boolean;
            openWorldHint?: boolean;
          };
          _meta?: { ui?: { visibility?: string[]; resourceUri?: string } };
        }>;
      };
    };
    const expectedNames = [
      "attach_image_to_ticket",
      "attach_image_to_time_entry",
      "call_connectwise",
      "create_agreement_addition",
      "create_schedule_entry",
      "create_service_ticket",
      "create_ticket_note",
      "create_time_entry",
      "delete_schedule_entry",
      "download_ticket_attachment",
      "get_agreement_additions",
      "get_agreement_additions_summary",
      "get_agreement_billing_summary",
      "get_board_options",
      "get_complete_ticket_content",
      "get_my_member",
      "get_service_boards",
      "get_service_priorities",
      "get_service_sources",
      "get_service_statuses",
      "get_service_ticket",
      "get_ticket_attachments_with_details",
      "get_ticket_notes_with_content",
      "get_time_sheets",
      "list_board_tickets",
      "list_schedule_entries",
      "list_ticket_tasks",
      "list_ticket_time_entries",
      "list_time_entries",
      "open_attachment_uploader",
      "search_agreement_additions",
      "search_companies",
      "search_contacts",
      "search_members",
      "search_tickets_by_content",
      "update_schedule_entry",
      "update_service_ticket",
      "upload_connectwise_image",
      "whoami",
    ];
    const names = body.result.tools.map(({ name }) => name);
    expect(names).toHaveLength(expectedNames.length);
    expect(new Set(names).size).toBe(expectedNames.length);
    expect([...names].sort()).toEqual(expectedNames);
    expect(Object.keys(TOOL_ACCESS).sort()).toEqual(expectedNames);
    for (const name of ["create_schedule_entry", "create_time_entry"]) {
      const tool = body.result.tools.find(
        (candidate) => candidate.name === name,
      );
      expect(tool?.inputSchema?.properties).not.toHaveProperty("memberId");
    }

    const appOnlyTools = body.result.tools.filter(
      (tool) =>
        tool._meta?.ui?.visibility !== undefined &&
        !tool._meta.ui.visibility.includes("model"),
    );
    expect(appOnlyTools).toHaveLength(1);
    expect(appOnlyTools[0]).toMatchObject({
      name: "upload_connectwise_image",
      _meta: { ui: { visibility: ["app"] } },
    });

    const writeNames = [
      "attach_image_to_ticket",
      "attach_image_to_time_entry",
      "create_agreement_addition",
      "create_schedule_entry",
      "create_service_ticket",
      "create_ticket_note",
      "create_time_entry",
      "delete_schedule_entry",
      "update_schedule_entry",
      "update_service_ticket",
      "upload_connectwise_image",
    ];
    const writeNameSet = new Set(writeNames);
    const writeTools = body.result.tools.filter((tool) =>
      writeNameSet.has(tool.name),
    );
    const readTools = body.result.tools.filter(
      (tool) => !writeNameSet.has(tool.name),
    );
    expect(writeTools).toHaveLength(11);
    expect(readTools).toHaveLength(28);
    const destructiveNameSet = new Set([
      "create_agreement_addition",
      "delete_schedule_entry",
      "update_schedule_entry",
      "update_service_ticket",
    ]);
    for (const tool of body.result.tools) {
      const expectedAccess = writeNameSet.has(tool.name) ? "write" : "read";
      expect(
        TOOL_ACCESS[tool.name as keyof typeof TOOL_ACCESS],
        tool.name,
      ).toBe(expectedAccess);
      expect(tool.annotations, tool.name).toBeDefined();
      expect(tool.annotations?.destructiveHint, tool.name).toBe(
        destructiveNameSet.has(tool.name),
      );
      expect(typeof tool.annotations?.openWorldHint, tool.name).toBe("boolean");
      expect(tool.annotations, tool.name).toMatchObject(
        writeNameSet.has(tool.name)
          ? { readOnlyHint: false, idempotentHint: false }
          : { readOnlyHint: true, idempotentHint: true },
      );
    }

    expect(
      body.result.tools.find(({ name }) => name === "open_attachment_uploader"),
    ).toMatchObject({
      annotations: { readOnlyHint: true },
      _meta: {
        ui: { resourceUri: "ui://connectwise/attachment-uploader.html" },
      },
    });
    for (const excluded of [
      "execute_api_call",
      "search_api_endpoints",
      "get_api_endpoint_details",
    ]) {
      expect(names).not.toContain(excluded);
    }
  });

  it.each([
    {
      name: "list_ticket_tasks",
      clientMethod: "getTicketTasks",
      upstream: {
        id: 7,
        summary: "Replace switch",
        priority: { id: 2, name: "High", secret: "drop" },
        status: { id: 3, name: "Open" },
        dueDate: "2026-09-15T12:00:00Z",
        notes: "n".repeat(4_100),
        privateField: "drop",
      },
      expected: '\\"summary\\":\\"Replace switch\\"',
      truncated: `\\"notes\\":\\"${"n".repeat(4_000)}\\"`,
    },
    {
      name: "list_ticket_time_entries",
      clientMethod: "getTicketTimeEntries",
      upstream: {
        id: 8,
        actualHours: 1.5,
        timeStart: "2026-09-12T12:00:00Z",
        member: { id: 4, name: "Alex", secret: "drop" },
        notes: "worked",
        workType: { id: 5, name: "Remote" },
        privateField: "drop",
      },
      expected: '\\"actualHours\\":1.5',
      truncated: '\\"notes\\":\\"worked\\"',
    },
  ])("returns bounded allowlisted projections from $name", async (testCase) => {
    const calls: Array<{ ticketId: number; maxResults: number }> = [];
    const client = businessClient({
      async getTicketTasks(ticketId: number, maxResults: number) {
        if (testCase.clientMethod !== "getTicketTasks") {
          throw new Error("unexpected task read");
        }
        calls.push({ ticketId, maxResults });
        return Array.from({ length: 3 }, () => testCase.upstream);
      },
      async getTicketTimeEntries(ticketId: number, maxResults: number) {
        if (testCase.clientMethod !== "getTicketTimeEntries") {
          throw new Error("unexpected time-entry read");
        }
        calls.push({ ticketId, maxResults });
        return Array.from({ length: 3 }, () => testCase.upstream);
      },
    });
    const handler = createMcpHandler(
      () =>
        createMcpServer(env, {
          createBusinessClient: () => client,
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
          id: 2,
          method: "tools/call",
          params: {
            name: testCase.name,
            arguments: { ticketId: 123, maxResults: 2 },
          },
        }),
      }),
    );
    const body = await response.text();
    expect(response.status, body).toBe(200);
    expect(calls).toEqual([{ ticketId: 123, maxResults: 2 }]);
    expect(body).toContain(testCase.expected);
    expect(body).toContain(testCase.truncated);
    expect(body).not.toContain("privateField");
    expect(body).not.toContain("secret");
    expect(body.match(/\\\"id\\\":/g)).toHaveLength(6);
  });

  it("fails closed when ticket-note visibility flags are missing or contradictory", async () => {
    const client = businessClient({
      async getTicketNotes(ticketId: number, maxResults: number) {
        expect(ticketId).toBe(123);
        expect(maxResults).toBe(20);
        return [
          { id: 1, text: "internal", internalFlag: true, externalFlag: false },
          { id: 2, text: "external", internalFlag: false, externalFlag: true },
          {
            id: 3,
            text: "analysis",
            internalFlag: null,
            internalAnalysisFlag: true,
            externalFlag: null,
          },
          {
            id: 4,
            text: "unknown",
            internalFlag: null,
            internalAnalysisFlag: null,
            externalFlag: null,
          },
          {
            id: 5,
            text: "both",
            internalFlag: true,
            externalFlag: true,
          },
          {
            id: 6,
            text: "unknown external",
            internalFlag: false,
          },
          {
            id: 7,
            text: "unknown internal",
            externalFlag: false,
          },
          {
            id: 8,
            text: "contradictory internal flags",
            internalFlag: false,
            internalAnalysisFlag: true,
            externalFlag: false,
          },
        ];
      },
    });

    const call = async (
      requestId: number,
      includeInternal?: boolean,
      includeExternal?: boolean,
    ): Promise<
      Array<{ id: number; internal?: boolean; external?: boolean }>
    > => {
      const handler = createMcpHandler(
        () =>
          createMcpServer(env, {
            createBusinessClient: () => client,
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
            id: requestId,
            method: "tools/call",
            params: {
              name: "get_ticket_notes_with_content",
              arguments: {
                ticketId: 123,
                includeInternal,
                includeExternal,
                maxResults: 20,
              },
            },
          }),
        }),
      );
      const eventStream = await response.text();
      expect(response.status, eventStream).toBe(200);
      const rpc = parseSseJsonRpcResponse(eventStream, requestId) as {
        result: { content: Array<{ type: string; text: string }> };
      };
      return JSON.parse(rpc.result.content[0]!.text) as Array<{
        id: number;
        internal?: boolean;
        external?: boolean;
      }>;
    };

    const internalOnly = await call(20, true, false);
    expect(internalOnly.map(({ id }) => id)).toEqual([1, 3, 5, 8]);
    expect(internalOnly.find(({ id }) => id === 3)).toEqual(
      expect.objectContaining({ internal: true }),
    );
    expect(internalOnly.find(({ id }) => id === 5)).toEqual(
      expect.objectContaining({ internal: true, external: false }),
    );

    const externalOnly = await call(21, false, true);
    expect(externalOnly.map(({ id }) => id)).toEqual([2]);

    const allClassified = await call(22, true, true);
    expect(allClassified.map(({ id }) => id)).toEqual([1, 2, 3, 5, 8]);
    expect(allClassified).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 4 })]),
    );

    const defaultVisibility = await call(23);
    expect(defaultVisibility.map(({ id }) => id)).toEqual([1, 2, 3, 5, 8]);

    await expect(call(24, false, false)).resolves.toEqual([]);
  });

  it("excludes unclassified notes from the complete ticket view", async () => {
    const client = businessClient({
      async getServiceTicket() {
        return { id: 123, summary: "Safe summary" };
      },
      async getTicketNotes() {
        return [
          { id: 1, text: "known internal", internalFlag: true },
          { id: 2, text: "known external", externalFlag: true },
          { id: 3, text: "unknown visibility" },
          {
            id: 4,
            text: "internal overrides contradictory external",
            internalAnalysisFlag: true,
            externalFlag: true,
          },
        ];
      },
      async getTicketAttachments() {
        return [];
      },
      async getTicketTasks() {
        return [];
      },
      async getTicketTimeEntries() {
        return [];
      },
    });
    const handler = createMcpHandler(
      () =>
        createMcpServer(env, {
          createBusinessClient: () => client,
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
          id: 25,
          method: "tools/call",
          params: {
            name: "get_complete_ticket_content",
            arguments: { ticketId: 123, maxResultsPerSection: 20 },
          },
        }),
      }),
    );
    const eventStream = await response.text();
    expect(response.status, eventStream).toBe(200);
    const rpc = parseSseJsonRpcResponse(eventStream, 25) as {
      result: { content: Array<{ type: string; text: string }> };
    };
    const complete = JSON.parse(rpc.result.content[0]!.text) as {
      notes: Array<{ id: number; internal?: boolean; external?: boolean }>;
    };
    expect(complete.notes.map(({ id }) => id)).toEqual([1, 2, 4]);
    expect(complete.notes.find(({ id }) => id === 4)).toEqual(
      expect.objectContaining({ internal: true, external: false }),
    );
  });

  it("bounds and projects schedule entries without accepting a caller member", async () => {
    const calls: number[] = [];
    const client = businessClient({
      async listScheduleEntries(maxResults: number) {
        calls.push(maxResults);
        return Array.from({ length: 3 }, (_, index) => ({
          id: index + 1,
          member: { id: 149, name: "Mapped Member", secret: "drop" },
          dateStart: "2026-09-19T12:00:00Z",
          dateEnd: "2026-09-19T13:00:00Z",
          name: "Scheduled work",
          privateField: "drop",
        }));
      },
    });
    const handler = createMcpHandler(
      () =>
        createMcpServer(env, {
          createBusinessClient: () => client,
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
          id: 3,
          method: "tools/call",
          params: {
            name: "list_schedule_entries",
            arguments: { maxResults: 2, memberId: 999 },
          },
        }),
      }),
    );
    const body = await response.text();
    expect(response.status, body).toBe(200);
    expect(calls).toEqual([2]);
    expect(body).toContain('\\"name\\":\\"Scheduled work\\"');
    expect(body).toContain('\\"name\\":\\"Mapped Member\\"');
    expect(body).not.toContain("privateField");
    expect(body).not.toContain("secret");
    expect(body).not.toContain("999");
    expect(body.match(/\\\"id\\\":/g)).toHaveLength(4);
  });

  it("searches a bounded member directory projection", async () => {
    const calls: Array<{ query: string; maxResults: number }> = [];
    const client = businessClient({
      async searchMembers(query: string, maxResults: number) {
        calls.push({ query, maxResults });
        return Array.from({ length: 3 }, (_, index) => ({
          id: index + 1,
          name: `Member ${index + 1}`,
          firstName: "Private",
          lastName: "Name",
          email: "must-not-escape@example.com",
          phone: "555-0100",
          status: { id: 1, name: "Active", secret: "drop" },
          privateKey: "drop",
        }));
      },
    });
    const handler = createMcpHandler(
      () =>
        createMcpServer(env, {
          createBusinessClient: () => client,
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
          id: 4,
          method: "tools/call",
          params: {
            name: "search_members",
            arguments: {
              query: "  Smith  ",
              maxResults: 2,
              profileAlias: "MAYA",
              host: "https://attacker.invalid",
              conditions: "id>0",
              privateKey: "hostile-private-key",
            },
          },
        }),
      }),
    );
    const body = await response.text();
    expect(response.status, body).toBe(200);
    expect(calls).toEqual([{ query: "Smith", maxResults: 2 }]);
    expect(body).toContain('\\"name\\":\\"Member 1\\"');
    expect(body).toContain('\\"name\\":\\"Member 2\\"');
    expect(body).not.toContain("Member 3");
    expect(body).not.toContain("must-not-escape");
    expect(body).not.toContain("555-0100");
    expect(body).not.toContain("Private");
    expect(body).not.toContain("hostile-private-key");
    expect(body).not.toContain("attacker.invalid");
    expect(body).not.toContain("conditions");
  });

  it.each([
    { label: "missing mcp:write", scopes: ["mcp:read"] },
    { label: "missing mcp:read", scopes: ["mcp:write"] },
    { label: "malformed string scopes", scopes: "mcp:read mcp:write" },
  ])(
    "denies every write tool with $label before resolving a profile",
    async ({ scopes }) => {
      const auditMessages: string[] = [];
      const bindingReads: string[] = [];
      let clientCreated = false;
      const guardedEnv = new Proxy(env, {
        get(target, property, receiver) {
          bindingReads.push(String(property));
          return Reflect.get(target, property, receiver);
        },
      });
      const handler = createMcpHandler(
        () =>
          createMcpServer(guardedEnv, {
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
            props: {
              profileAlias: "LUIS",
              scopes: scopes as string[],
            },
          },
        },
      );
      const writes: Array<{
        name: string;
        arguments: Record<string, unknown>;
      }> = [
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
        expect(await response.text(), write.name).toContain(
          "Insufficient scope",
        );
      }

      expect(clientCreated).toBe(false);
      expect(bindingReads).toEqual([]);
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
    },
  );

  it("denies every read tool without mcp:read before resolving a profile", async () => {
    const auditMessages: string[] = [];
    const bindingReads: string[] = [];
    let directClientCreated = false;
    let businessClientCreated = false;
    const guardedEnv = new Proxy(env, {
      get(target, property, receiver) {
        bindingReads.push(String(property));
        return Reflect.get(target, property, receiver);
      },
    });
    const handler = createMcpHandler(
      () =>
        createMcpServer(guardedEnv, {
          audit: { logger: (message) => auditMessages.push(message) },
          createClient: () => {
            directClientCreated = true;
            return businessClient();
          },
          createBusinessClient: () => {
            businessClientCreated = true;
            return businessClient();
          },
        }),
      {
        route: "/mcp",
        corsOptions: false,
        authContext: {
          props: { profileAlias: "LUIS", scopes: ["mcp:write"] },
        },
      },
    );
    const reads: Array<{
      name: string;
      arguments: Record<string, unknown>;
    }> = [
      { name: "whoami", arguments: {} },
      { name: "get_service_ticket", arguments: { ticketId: 1 } },
      {
        name: "search_tickets_by_content",
        arguments: { searchText: "must not be sent" },
      },
      { name: "get_ticket_notes_with_content", arguments: { ticketId: 1 } },
      {
        name: "get_ticket_attachments_with_details",
        arguments: { ticketId: 1 },
      },
      { name: "list_ticket_tasks", arguments: { ticketId: 1 } },
      { name: "list_ticket_time_entries", arguments: { ticketId: 1 } },
      { name: "get_complete_ticket_content", arguments: { ticketId: 1 } },
      { name: "get_service_boards", arguments: {} },
      { name: "get_board_options", arguments: { boardId: 1 } },
      { name: "list_board_tickets", arguments: { boardId: 1 } },
      { name: "get_service_statuses", arguments: {} },
      { name: "get_service_priorities", arguments: {} },
      { name: "get_service_sources", arguments: {} },
      { name: "get_my_member", arguments: {} },
      { name: "search_members", arguments: { query: "must not be sent" } },
      { name: "search_companies", arguments: { query: "must not be sent" } },
      { name: "search_contacts", arguments: { query: "must not be sent" } },
      { name: "list_time_entries", arguments: {} },
      { name: "list_schedule_entries", arguments: {} },
      { name: "get_time_sheets", arguments: {} },
      {
        name: "download_ticket_attachment",
        arguments: { ticketId: 1, documentId: 1 },
      },
      { name: "open_attachment_uploader", arguments: {} },
      {
        name: "call_connectwise",
        arguments: { route: "service.boards.statuses", boardId: 1 },
      },
      { name: "get_agreement_additions", arguments: { agreementId: 1 } },
      {
        name: "get_agreement_additions_summary",
        arguments: { agreementId: 1 },
      },
      {
        name: "search_agreement_additions",
        arguments: { agreementId: 1 },
      },
      {
        name: "get_agreement_billing_summary",
        arguments: { agreementId: 1 },
      },
    ];
    expect(reads.map(({ name }) => name).sort()).toEqual(
      Object.entries(TOOL_ACCESS)
        .filter(([, access]) => access === "read")
        .map(([name]) => name)
        .sort(),
    );

    for (const [index, read] of reads.entries()) {
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
            id: 40 + index,
            method: "tools/call",
            params: read,
          }),
        }),
      );
      expect(await response.text(), read.name).toContain("Insufficient scope");
    }

    expect(directClientCreated).toBe(false);
    expect(businessClientCreated).toBe(false);
    expect(bindingReads).toEqual([]);
    expect(auditMessages).toHaveLength(reads.length);
    expect(auditMessages.map((message) => JSON.parse(message).tool)).toEqual(
      reads.map(({ name }) => name),
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

  it("rejects attachment resource reads without mcp:read before profile access", async () => {
    let bindingReads = 0;
    let clientCreations = 0;
    const guardedEnv = new Proxy(
      {},
      {
        get() {
          bindingReads += 1;
          throw new Error("profile binding must not be read");
        },
      },
    );
    const handler = createMcpHandler(
      () =>
        createMcpServer(guardedEnv, {
          createBusinessClient: () => {
            clientCreations += 1;
            return businessClient();
          },
        }),
      {
        route: "/mcp",
        corsOptions: false,
        authContext: {
          props: { profileAlias: "LUIS", scopes: ["mcp:write"] },
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
          id: 23,
          method: "resources/read",
          params: {
            uri: "ui://connectwise/attachment-uploader.html",
          },
        }),
      }),
    );
    const body = await response.text();
    expect(body).toContain("Insufficient scope");
    expect(body).not.toContain("Drop or paste an image here");
    expect(body).not.toContain("upload_connectwise_image");
    expect(bindingReads).toBe(0);
    expect(clientCreations).toBe(0);
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
              includeClosed: "true",
            },
          },
        }),
      }),
    );
    const thirdBody = await third.text();
    expect(calls[2]).toEqual({
      route: "service.tickets.byOwner",
      params: { pageSize: 20, includeClosed: "true" },
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

  it("downloads only an attachment associated with the specified ticket", async () => {
    const attachmentLookups: Array<{ ticketId: number; pageSize: number }> = [];
    const downloads: number[] = [];
    const handler = createMcpHandler(
      () =>
        createMcpServer(env, {
          createBusinessClient: () =>
            businessClient({
              async getTicketAttachments(ticketId, pageSize) {
                attachmentLookups.push({ ticketId, pageSize });
                return [{ id: 400 }, { id: "400" }, { id: 401 }];
              },
              async downloadDocument(documentId) {
                downloads.push(documentId);
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
          props: { profileAlias: "LUIS", scopes: ["mcp:read"] },
        },
      },
    );

    const callTool = (id: number, documentId: number) =>
      handler.fetch(
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
              name: "download_ticket_attachment",
              arguments: { ticketId: 123, documentId },
            },
          }),
        }),
      );

    const allowed = await callTool(54, 400);
    const allowedBody = await allowed.text();
    expect(allowedBody).toContain('\\"base64\\":\\"QUJD\\"');
    expect(allowedBody).toContain('\\"mimeType\\":\\"application/pdf\\"');
    expect(attachmentLookups).toEqual([{ ticketId: 123, pageSize: 50 }]);
    expect(downloads).toEqual([400]);

    const denied = await callTool(55, 402);
    const deniedBody = await denied.text();
    expect(deniedBody).toContain("Attachment not found for ticket");
    expect(attachmentLookups).toEqual([
      { ticketId: 123, pageSize: 50 },
      { ticketId: 123, pageSize: 50 },
    ]);
    expect(downloads).toEqual([400]);
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

  it("rejects wildcard and underspecified directory searches before profile access", async () => {
    let clientCreations = 0;
    const handler = createMcpHandler(
      () =>
        createMcpServer(env, {
          createBusinessClient: () => {
            clientCreations += 1;
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

    const invalidCalls = [
      { name: "search_companies", arguments: { query: "%" } },
      { name: "search_contacts", arguments: { query: "A_" } },
      {
        name: "call_connectwise",
        arguments: { route: "company.configurations", query: "%" },
      },
      {
        name: "call_connectwise",
        arguments: { route: "company.configurations" },
      },
      {
        name: "call_connectwise",
        arguments: {
          route: "service.tickets.byOwner",
          memberId: 999,
        },
      },
      {
        name: "call_connectwise",
        arguments: {
          route: "company.configurations",
          query: "router",
          pageSize: 21,
        },
      },
      {
        name: "call_connectwise",
        arguments: { route: "finance.agreements.byName", name: "x" },
      },
    ];
    for (const [index, params] of invalidCalls.entries()) {
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
            id: 560 + index,
            method: "tools/call",
            params,
          }),
        }),
      );
      expect(await response.text()).toMatch(/invalid|wildcard|too_small/i);
    }
    expect(clientCreations).toBe(0);
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
  it("create_schedule_entry ignores a caller member and uses the mapped profile member", async () => {
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
              memberId: 999,
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

  it("delete_schedule_entry verifies mapped-member ownership before DELETE", async () => {
    const calls: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const method = (init as { method?: string } | undefined)?.method ?? "GET";
      calls.push(`${method} ${String(input)}`);
      return method === "GET"
        ? Response.json({ id: 247134, member: { id: 149 } })
        : new Response(null, { status: 204 });
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
    expect(calls).toEqual([
      "GET https://api-na.myconnectwise.net/v4_6_release/apis/3.0/schedule/entries/247134",
      "DELETE https://api-na.myconnectwise.net/v4_6_release/apis/3.0/schedule/entries/247134",
    ]);
  });

  it("create_time_entry uses the mapped profile member on the wire", async () => {
    const bodies: Array<{ method: string; url: string; body?: unknown }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const method = (init as { method?: string } | undefined)?.method ?? "GET";
      const rawBody = (init as { body?: string } | undefined)?.body;
      bodies.push({
        method,
        url: String(input),
        ...(rawBody ? { body: JSON.parse(rawBody) } : {}),
      });
      return String(input).includes("/time/sheets")
        ? Response.json([])
        : Response.json({ id: 123, member: { id: 149 } });
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
              memberId: 999,
              timeStart: "2026-09-01T12:00:00-04:00",
              timeEnd: "2026-09-01T13:00:00-04:00",
            },
          },
        }),
      }),
    );
    const text = await response.text();
    const post = bodies.find(
      (body) => body.method === "POST" && body.url.endsWith("/time/entries"),
    );
    expect(post).toBeDefined();
    expect((post!.body as { member: { id: number } }).member.id).toBe(149);
    expect(text).toContain('\\"id\\":123');
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
              memberId: 999,
              timeStart: "2026-09-01T12:00:00-04:00",
              timeEnd: "2026-09-01T13:00:00-04:00",
            },
          },
        }),
      }),
    );
    const text = await response.text();
    expect(text).toContain("pending approval");
    expect(text).toContain("approve or recall it before retrying");
    const sheetLookup = new URL(
      bodies.find((body) => body.url.includes("/time/sheets"))!.url,
    );
    expect(sheetLookup.searchParams.get("conditions")).toBe("member/id=149");
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
    expect(text).toContain("call get_board_options");
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

  it("update_service_ticket never heuristically deletes schedule entries", async () => {
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
    expect(
      bodies.some(
        (b) => b.method === "GET" && b.url.includes("/schedule/entries"),
      ),
    ).toBe(false);
    expect(bodies.some((b) => b.method === "DELETE")).toBe(false);
    expect(text).toContain('\\"id\\":1927963');
    expect(text).not.toContain("ghostScheduleEntryIdsRemoved");
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

  it("rejects reversed agreement search dates before a ConnectWise call", async () => {
    let searchCalls = 0;
    const handler = createMcpHandler(
      () =>
        createMcpServer(env, {
          createBusinessClient: () =>
            businessClient({
              async getAgreementAdditions() {
                searchCalls += 1;
                return [];
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
    const post = async (
      id: number,
      dates: { dateFrom?: string; dateTo?: string },
    ) => {
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
              name: "search_agreement_additions",
              arguments: { agreementId: 17, maxResults: 10, ...dates },
            },
          }),
        }),
      );
      return response.text();
    };

    const reversed = await post(8, {
      dateFrom: "2026-09-02",
      dateTo: "2026-09-01",
    });
    expect(reversed).toContain("dateFrom must not be after dateTo");
    expect(searchCalls).toBe(0);

    const equal = await post(9, {
      dateFrom: "2026-09-02",
      dateTo: "2026-09-02",
    });
    const oneSided = await post(10, { dateFrom: "2026-09-02" });
    expect(equal).toContain('"text":"[]"');
    expect(oneSided).toContain('"text":"[]"');
    expect(searchCalls).toBe(2);
  });
});
