import { describe, expect, it } from "vitest";
import {
  ConnectWiseIndeterminateWriteError,
  ConnectWisePartialServiceTicketCreateError,
  ConnectWiseRequestError,
  MAX_CONNECTWISE_RESPONSE_CHUNKS,
  MAX_DOWNLOAD_BYTES,
  MAX_IMAGE_UPLOAD_BYTES,
  createConnectWiseClient,
  decodeConnectWiseImageBase64,
} from "../src/connectwise-client";
import type { ConnectWiseCredentials } from "../src/connectwise-profile";

const credentials: ConnectWiseCredentials = {
  apiBaseUrl: "https://api-na.myconnectwise.net/v4_6_release/apis/3.0",
  companyId: "acme",
  publicKey: "public-key",
  privateKey: "private-key",
  clientId: "partner-client-id",
  memberId: 149,
};

const serviceTicketReadFields =
  "id,summary,company,board,status,priority,type,owner,contact,closedFlag,closedDate,dateResolved,_info";
const configurationCollectionFields =
  "id,name,type,status,company,site,contact";
const agreementCollectionFields =
  "id,name,type,company,agreementStatus,billingCycle,billAmount,nextInvoiceDate";
const agreementAdditionCollectionFields =
  "id,product,quantity,unitPrice,unitCost,extPrice,extCost,effectiveDate,cancelledDate,billCustomer,description,agreementId";
const timeEntryCollectionFields =
  "id,actualHours,timeStart,member,notes,workType";
const ticketTimeEntryRelationshipFields = `${timeEntryCollectionFields},chargeToType,chargeToId`;
const timeEntryReadFields = `${timeEntryCollectionFields},dateEntered,chargeToType`;
const scheduleEntryCollectionFields =
  "id,member,dateStart,dateEnd,name,hours,doneFlag,type,status";
const timeSheetCollectionFields =
  "id,member,year,period,dateStart,dateEnd,status,hours,deadline";
const agreementAdditionSummaryFields = "extPrice,extCost,agreementId";
const agreementInvoiceCollectionFields =
  "id,invoiceNumber,total,date,agreement";
const serviceTicketNoteCollectionFields =
  "id,text,dateCreated,createdBy,internalFlag,internalAnalysisFlag,externalFlag,resolutionFlag,issueFlag,detailDescriptionFlag,contact,ticketId";
const ticketAttachmentCollectionFields =
  "id,title,fileName,size,documentType,owner,createdOnDate,_info,publicFlag,readOnlyFlag,linkFlag,imageFlag,recordType,recordId";
const ticketTaskCollectionFields =
  "id,summary,priority,notes,closedFlag,ticketId";
const serviceBoardCollectionFields = "id,name";
const boardStatusCollectionFields = "id,name";
const boardTypeCollectionFields = "id,name";
const serviceStatusCollectionFields = "id,name";
const servicePriorityCollectionFields = "id,name";
const serviceSourceCollectionFields = "id,name";
const memberDetailFields = "id,name,firstName,lastName,email,phone,status";

function fragmentedResponse(
  firstChunk: Uint8Array,
  chunkCount: number,
  options: {
    filler?: Uint8Array;
    contentType?: string;
    closeAfter?: boolean;
    cancel?: () => void;
  } = {},
): Response {
  let emitted = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emitted === chunkCount) {
          if (options.closeAfter !== false) controller.close();
          return;
        }
        controller.enqueue(
          emitted === 0 ? firstChunk : (options.filler ?? new Uint8Array()),
        );
        emitted += 1;
      },
      cancel() {
        options.cancel?.();
      },
    }),
    options.contentType
      ? { headers: { "Content-Type": options.contentType } }
      : undefined,
  );
}

describe("ConnectWiseClient", () => {
  it("gets one service ticket with minimized fields and request-scoped authentication", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetcher: typeof fetch = async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return Response.json({ id: 123, status: { name: "New" } });
    };
    const client = createConnectWiseClient(credentials, { fetcher });

    await expect(client.getServiceTicketStatus(123)).resolves.toEqual({
      id: 123,
      status: { name: "New" },
    });
    const url = new URL(capturedUrl);
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://api-na.myconnectwise.net/v4_6_release/apis/3.0/service/tickets/123",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      fields: "id,status",
    });
    expect(url.searchParams.getAll("fields")).toEqual(["id,status"]);
    expect(capturedInit?.method).toBe("GET");
    // Workers does not implement redirect:"error" (throws synchronously);
    // 3xx responses are refused explicitly by the client instead.
    expect(capturedInit?.redirect).toBe("manual");
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get("Authorization")).toBe(
      `Basic ${btoa("acme+public-key:private-key")}`,
    );
    expect(headers.get("clientId")).toBe("partner-client-id");
    expect(headers.get("Accept")).toBe("application/json");
  });

  it("minimizes the detailed service-ticket request for aggregate views", async () => {
    let capturedUrl = "";
    const detailedTicket = {
      id: 123,
      summary: "Printer offline",
      status: { name: "New" },
      company: { id: 7, name: "Acme" },
    };
    const client = createConnectWiseClient(credentials, {
      fetcher: async (input) => {
        capturedUrl = String(input);
        return Response.json(detailedTicket);
      },
    });

    await expect(client.getServiceTicket(123)).resolves.toEqual(detailedTicket);
    const url = new URL(capturedUrl);
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://api-na.myconnectwise.net/v4_6_release/apis/3.0/service/tickets/123",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      fields: serviceTicketReadFields,
    });
    expect(url.searchParams.getAll("fields")).toEqual([
      serviceTicketReadFields,
    ]);
  });

  it("rejects malformed or mismatched direct service-ticket responses", async () => {
    const invalidTickets: unknown[] = [
      null,
      [],
      {},
      { id: "123" },
      { id: 124, summary: "Wrong ticket" },
    ];

    for (const invalidTicket of invalidTickets) {
      const client = createConnectWiseClient(credentials, {
        fetcher: async () => Response.json(invalidTicket),
      });

      await expect(client.getServiceTicket(123)).rejects.toThrow(
        "ConnectWise service ticket does not match requested ID",
      );
      await expect(client.getServiceTicketStatus(123)).rejects.toThrow(
        "ConnectWise service ticket does not match requested ID",
      );
    }
  });

  it("scopes attachment lookup to one ticket and a bounded page", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const client = createConnectWiseClient(credentials, {
      fetcher: async (input, init) => {
        capturedUrl = String(input);
        capturedInit = init;
        return Response.json([
          { id: 400, recordType: "Ticket", recordId: 123 },
        ]);
      },
    });

    await expect(client.getTicketAttachments(123, 50)).resolves.toEqual([
      { id: 400 },
    ]);
    const url = new URL(capturedUrl);
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://api-na.myconnectwise.net/v4_6_release/apis/3.0/system/documents",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      recordType: "Ticket",
      recordId: "123",
      fields: ticketAttachmentCollectionFields,
      pageSize: "50",
    });
    expect(url.searchParams.getAll("fields")).toEqual([
      ticketAttachmentCollectionFields,
    ]);
    expect(capturedInit?.method).toBe("GET");
  });

  it("rejects attachment rows that do not match the requested ticket", async () => {
    for (const document of [
      { id: 400, recordType: "Ticket", recordId: 124 },
      { id: 400, recordType: "Project", recordId: 123 },
      { id: 400, recordType: "Ticket" },
      { id: 400, recordId: 123 },
    ]) {
      const client = createConnectWiseClient(credentials, {
        fetcher: async () => Response.json([document]),
      });

      await expect(client.getTicketAttachments(123, 50)).rejects.toThrow(
        "ConnectWise document is not associated with requested record",
      );
    }
  });

  it("authorizes one ticket attachment by exact document identity", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const client = createConnectWiseClient(credentials, {
      fetcher: async (input, init) => {
        capturedUrl = String(input);
        capturedInit = init;
        return Response.json({
          id: 400,
          recordType: "Ticket",
          recordId: 123,
        });
      },
    });

    await expect(client.getTicketAttachment(123, 400)).resolves.toEqual({
      id: 400,
    });
    const url = new URL(capturedUrl);
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://api-na.myconnectwise.net/v4_6_release/apis/3.0/system/documents/400",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      fields: "id,recordType,recordId",
    });
    expect(capturedInit?.method).toBe("GET");
  });

  it("rejects wrong-target or malformed exact attachment responses", async () => {
    for (const document of [
      null,
      [],
      {},
      { id: "400", recordType: "Ticket", recordId: 123 },
      { id: 401, recordType: "Ticket", recordId: 123 },
      { id: 400, recordType: "Ticket", recordId: 124 },
      { id: 400, recordType: "Project", recordId: 123 },
      { id: 400, recordType: "Ticket" },
    ]) {
      const client = createConnectWiseClient(credentials, {
        fetcher: async () => Response.json(document),
      });

      await expect(client.getTicketAttachment(123, 400)).rejects.toThrow(
        /ConnectWise (document does not match requested ID|document is not associated with requested record)/,
      );
    }
  });

  it("verifies and strips document relationships from catalog results", async () => {
    const client = createConnectWiseClient(credentials, {
      fetcher: async () =>
        Response.json([
          {
            id: 400,
            title: "router.pdf",
            recordType: "Company",
            recordId: 77,
          },
        ]),
    });

    await expect(
      client.catalogGet("system.documents", {
        recordType: "Company",
        recordId: 77,
        pageSize: 20,
      }),
    ).resolves.toEqual([{ id: 400, title: "router.pdf" }]);
  });

  it("rejects mismatched document relationships from catalog results", async () => {
    const client = createConnectWiseClient(credentials, {
      fetcher: async () =>
        Response.json([{ id: 400, recordType: "Company", recordId: 78 }]),
    });

    await expect(
      client.catalogGet("system.documents", {
        recordType: "Company",
        recordId: 77,
        pageSize: 20,
      }),
    ).rejects.toThrow(
      "ConnectWise document is not associated with requested record",
    );
  });

  it("minimizes service-ticket notes and tasks at the upstream boundary", async () => {
    const urls: string[] = [];
    const client = createConnectWiseClient(credentials, {
      fetcher: async (input) => {
        urls.push(String(input));
        return Response.json([]);
      },
    });

    await expect(
      client.getTicketNotes(123, 20, {
        includeInternal: true,
        includeExternal: true,
      }),
    ).resolves.toEqual([]);
    await expect(client.getTicketTasks(123, 20)).resolves.toEqual([]);

    expect(urls).toHaveLength(2);
    const serviceNotesUrl = new URL(urls[0]!);
    const tasksUrl = new URL(urls[1]!);
    expect(
      serviceNotesUrl.pathname.endsWith("/service/tickets/123/notes"),
    ).toBe(true);
    expect(Object.fromEntries(serviceNotesUrl.searchParams)).toEqual({
      conditions:
        "(internalFlag=true OR internalAnalysisFlag=true OR externalFlag=true)",
      fields: serviceTicketNoteCollectionFields,
      pageSize: "20",
      orderBy: "dateCreated desc",
    });
    expect(serviceNotesUrl.searchParams.getAll("fields")).toEqual([
      serviceTicketNoteCollectionFields,
    ]);
    expect(tasksUrl.pathname.endsWith("/service/tickets/123/tasks")).toBe(true);
    expect(Object.fromEntries(tasksUrl.searchParams)).toEqual({
      fields: ticketTaskCollectionFields,
      pageSize: "20",
    });
    expect(tasksUrl.searchParams.getAll("fields")).toEqual([
      ticketTaskCollectionFields,
    ]);
  });

  it("applies ticket-note visibility before the upstream result bound", async () => {
    const urls: string[] = [];
    const client = createConnectWiseClient(credentials, {
      fetcher: async (input) => {
        urls.push(String(input));
        return Response.json([]);
      },
    });

    await client.getTicketNotes(123, 7, {
      includeInternal: false,
      includeExternal: true,
    });
    await client.getTicketNotes(123, 8, {
      includeInternal: true,
      includeExternal: false,
    });
    await client.getTicketNotes(123, 9, {
      includeInternal: true,
      includeExternal: true,
    });

    expect(urls).toHaveLength(3);
    expect(Object.fromEntries(new URL(urls[0]!).searchParams)).toEqual({
      conditions:
        "externalFlag=true AND internalFlag=false AND internalAnalysisFlag=false",
      fields: serviceTicketNoteCollectionFields,
      pageSize: "7",
      orderBy: "dateCreated desc",
    });
    expect(Object.fromEntries(new URL(urls[1]!).searchParams)).toEqual({
      conditions: "(internalFlag=true OR internalAnalysisFlag=true)",
      fields: serviceTicketNoteCollectionFields,
      pageSize: "8",
      orderBy: "dateCreated desc",
    });
    expect(Object.fromEntries(new URL(urls[2]!).searchParams)).toEqual({
      conditions:
        "(internalFlag=true OR internalAnalysisFlag=true OR externalFlag=true)",
      fields: serviceTicketNoteCollectionFields,
      pageSize: "9",
      orderBy: "dateCreated desc",
    });
  });

  it("does not fetch ticket notes when neither visibility class is requested", async () => {
    let fetchCount = 0;
    const client = createConnectWiseClient(credentials, {
      fetcher: async () => {
        fetchCount += 1;
        return Response.json([]);
      },
    });

    await expect(
      client.getTicketNotes(123, 20, {
        includeInternal: false,
        includeExternal: false,
      }),
    ).resolves.toEqual([]);
    expect(fetchCount).toBe(0);
  });

  it("returns the bounded recent-note window in chronological order", async () => {
    const client = createConnectWiseClient(credentials, {
      fetcher: async () =>
        Response.json([
          {
            id: 303,
            dateCreated: "2026-10-15T12:00:00Z",
            ticketId: 123,
          },
          {
            id: 302,
            dateCreated: "2026-10-15T11:00:00Z",
            ticketId: 123,
          },
          {
            id: 301,
            dateCreated: "2026-10-15T10:00:00Z",
            ticketId: 123,
          },
        ]),
    });

    await expect(
      client.getTicketNotes(123, 3, {
        includeInternal: true,
        includeExternal: true,
      }),
    ).resolves.toEqual([
      { id: 301, dateCreated: "2026-10-15T10:00:00Z" },
      { id: 302, dateCreated: "2026-10-15T11:00:00Z" },
      { id: 303, dateCreated: "2026-10-15T12:00:00Z" },
    ]);
  });

  it.each([
    {
      name: "ascending",
      notes: [
        {
          id: 301,
          dateCreated: "2026-10-15T10:00:00Z",
          ticketId: 123,
        },
        {
          id: 302,
          dateCreated: "2026-10-15T11:00:00Z",
          ticketId: 123,
        },
      ],
    },
    {
      name: "missing timestamp",
      notes: [{ id: 301, ticketId: 123 }],
    },
    {
      name: "malformed timestamp",
      notes: [{ id: 301, dateCreated: "not-a-date", ticketId: 123 }],
    },
  ])(
    "rejects $name ticket-note order before auditing success",
    async ({ notes }) => {
      const logs: string[] = [];
      const client = createConnectWiseClient(credentials, {
        fetcher: async () => Response.json(notes),
        log: (line) => logs.push(line),
      });

      await expect(
        client.getTicketNotes(123, 20, {
          includeInternal: true,
          includeExternal: true,
        }),
      ).rejects.toThrow(
        "ConnectWise ticket notes are not ordered recent-first",
      );
      expect(logs).toHaveLength(1);
      expect(JSON.parse(logs[0]!)).toEqual({
        event: "cw_request",
        method: "GET",
        status: 200,
        latencyMs: expect.any(Number),
        outcome: "upstream_error",
      });
    },
  );

  it("verifies and strips ticket relationships from note results", async () => {
    const client = createConnectWiseClient(credentials, {
      fetcher: async () =>
        Response.json([
          {
            id: 301,
            text: "Customer update",
            dateCreated: "2026-10-15T12:00:00Z",
            ticketId: 123,
          },
        ]),
    });

    await expect(
      client.getTicketNotes(123, 20, {
        includeInternal: true,
        includeExternal: true,
      }),
    ).resolves.toEqual([
      {
        id: 301,
        text: "Customer update",
        dateCreated: "2026-10-15T12:00:00Z",
      },
    ]);
  });

  it.each([
    { id: 301, dateCreated: "2026-10-15T12:00:00Z", ticketId: 124 },
    { id: 301, dateCreated: "2026-10-15T12:00:00Z" },
    { id: 301, dateCreated: "2026-10-15T12:00:00Z", ticketId: "123" },
  ])(
    "rejects a note without the exact requested ticket relationship: %j",
    async (note) => {
      const client = createConnectWiseClient(credentials, {
        fetcher: async () => Response.json([note]),
      });

      await expect(
        client.getTicketNotes(123, 20, {
          includeInternal: true,
          includeExternal: true,
        }),
      ).rejects.toThrow(
        "ConnectWise note is not associated with requested ticket",
      );
    },
  );

  it("rejects a mismatched note later in the bounded result", async () => {
    const client = createConnectWiseClient(credentials, {
      fetcher: async () =>
        Response.json([
          {
            id: 301,
            dateCreated: "2026-10-15T12:00:00Z",
            ticketId: 123,
          },
          {
            id: 302,
            dateCreated: "2026-10-15T11:00:00Z",
            ticketId: 124,
          },
        ]),
    });

    await expect(
      client.getTicketNotes(123, 20, {
        includeInternal: true,
        includeExternal: true,
      }),
    ).rejects.toThrow(
      "ConnectWise note is not associated with requested ticket",
    );
  });

  it("verifies and strips ticket relationships from task results", async () => {
    const client = createConnectWiseClient(credentials, {
      fetcher: async () =>
        Response.json([
          {
            id: 401,
            summary: "Call customer",
            priority: 1,
            notes: "Confirm maintenance window",
            closedFlag: false,
            ticketId: 123,
          },
        ]),
    });

    await expect(client.getTicketTasks(123, 20)).resolves.toEqual([
      {
        id: 401,
        summary: "Call customer",
        priority: 1,
        notes: "Confirm maintenance window",
        closedFlag: false,
      },
    ]);
  });

  it.each([
    { id: 401, ticketId: 124 },
    { id: 401 },
    { id: 401, ticketId: "123" },
  ])(
    "rejects a task without the exact requested ticket relationship: %j",
    async (task) => {
      const client = createConnectWiseClient(credentials, {
        fetcher: async () => Response.json([task]),
      });

      await expect(client.getTicketTasks(123, 20)).rejects.toThrow(
        "ConnectWise task is not associated with requested ticket",
      );
    },
  );

  it("rejects a mismatched task later in the bounded result", async () => {
    const client = createConnectWiseClient(credentials, {
      fetcher: async () =>
        Response.json([
          { id: 401, ticketId: 123 },
          { id: 402, ticketId: 124 },
        ]),
    });

    await expect(client.getTicketTasks(123, 20)).rejects.toThrow(
      "ConnectWise task is not associated with requested ticket",
    );
  });

  it("does not probe project-ticket notes when a service ticket is absent", async () => {
    const urls: string[] = [];
    const client = createConnectWiseClient(credentials, {
      fetcher: async (input) => {
        urls.push(String(input));
        return new Response(null, { status: 404 });
      },
    });

    await expect(
      client.getTicketNotes(123, 20, {
        includeInternal: true,
        includeExternal: true,
      }),
    ).rejects.toThrow("ConnectWise request failed (404)");
    expect(urls).toHaveLength(1);
    expect(
      new URL(urls[0]!).pathname.endsWith("/service/tickets/123/notes"),
    ).toBe(true);
  });

  it("minimizes ticket time-entry reads, verifies their relationship, and strips verification fields", async () => {
    let capturedUrl = "";
    const client = createConnectWiseClient(credentials, {
      fetcher: async (input) => {
        capturedUrl = String(input);
        return Response.json([
          {
            id: 401,
            chargeToType: "ServiceTicket",
            chargeToId: 123,
          },
        ]);
      },
    });

    await expect(client.getTicketTimeEntries(123, 20)).resolves.toEqual([
      { id: 401 },
    ]);
    const url = new URL(capturedUrl);
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://api-na.myconnectwise.net/v4_6_release/apis/3.0/time/entries",
    );
    expect(url.searchParams.get("conditions")).toBe(
      "chargeToType='ServiceTicket' AND chargeToId=123",
    );
    expect(url.searchParams.get("conditions")).not.toMatch(
      /ProjectTicket|\bOR\b/,
    );
    expect(url.searchParams.getAll("fields")).toEqual([
      ticketTimeEntryRelationshipFields,
    ]);
    expect(url.searchParams.get("orderBy")).toBe("dateEntered desc");
    expect(url.searchParams.get("pageSize")).toBe("20");
  });

  it.each([
    { id: 401, chargeToType: "ServiceTicket", chargeToId: 124 },
    { id: 401, chargeToType: "ProjectTicket", chargeToId: 123 },
    { id: 401, chargeToType: "ServiceTicket" },
    { id: 401, chargeToId: 123 },
  ])(
    "rejects a time entry without the exact requested ticket relationship: %j",
    async (entry) => {
      const client = createConnectWiseClient(credentials, {
        fetcher: async () => Response.json([entry]),
      });

      await expect(client.getTicketTimeEntries(123, 20)).rejects.toThrow(
        "ConnectWise time entry is not associated with requested ticket",
      );
    },
  );

  it("audits ticket-child relationship validation before reporting request success", async () => {
    type Client = ReturnType<typeof createConnectWiseClient>;
    const cases: Array<{
      name: string;
      validResponse: unknown;
      invalidResponse: unknown;
      exercise: (client: Client) => Promise<unknown>;
      expected: unknown;
      error: string;
    }> = [
      {
        name: "notes",
        validResponse: [
          {
            id: 301,
            dateCreated: "2026-10-15T12:00:00Z",
            ticketId: 123,
          },
        ],
        invalidResponse: [
          {
            id: 301,
            dateCreated: "2026-10-15T12:00:00Z",
            ticketId: 124,
          },
        ],
        exercise: (client) =>
          client.getTicketNotes(123, 20, {
            includeInternal: true,
            includeExternal: true,
          }),
        expected: [{ id: 301, dateCreated: "2026-10-15T12:00:00Z" }],
        error: "ConnectWise note is not associated with requested ticket",
      },
      {
        name: "attachment list",
        validResponse: [{ id: 400, recordType: "Ticket", recordId: 123 }],
        invalidResponse: [{ id: 400, recordType: "Ticket", recordId: 124 }],
        exercise: (client) => client.getTicketAttachments(123, 20),
        expected: [{ id: 400 }],
        error: "ConnectWise document is not associated with requested record",
      },
      {
        name: "exact attachment",
        validResponse: { id: 400, recordType: "Ticket", recordId: 123 },
        invalidResponse: { id: 400, recordType: "Ticket", recordId: 124 },
        exercise: (client) => client.getTicketAttachment(123, 400),
        expected: { id: 400 },
        error: "ConnectWise document is not associated with requested record",
      },
      {
        name: "tasks",
        validResponse: [{ id: 401, ticketId: 123 }],
        invalidResponse: [{ id: 401, ticketId: 124 }],
        exercise: (client) => client.getTicketTasks(123, 20),
        expected: [{ id: 401 }],
        error: "ConnectWise task is not associated with requested ticket",
      },
      {
        name: "time entries",
        validResponse: [
          { id: 501, chargeToType: "ServiceTicket", chargeToId: 123 },
        ],
        invalidResponse: [
          { id: 501, chargeToType: "ServiceTicket", chargeToId: 124 },
        ],
        exercise: (client) => client.getTicketTimeEntries(123, 20),
        expected: [{ id: 501 }],
        error: "ConnectWise time entry is not associated with requested ticket",
      },
    ];

    for (const testCase of cases) {
      const failureLogs: string[] = [];
      const failingClient = createConnectWiseClient(credentials, {
        fetcher: async () => Response.json(testCase.invalidResponse),
        log: (line) => failureLogs.push(line),
      });

      await expect(
        testCase.exercise(failingClient),
        testCase.name,
      ).rejects.toThrow(testCase.error);
      expect(failureLogs, testCase.name).toHaveLength(1);
      expect(JSON.parse(failureLogs[0]!), testCase.name).toEqual({
        event: "cw_request",
        method: "GET",
        status: 200,
        latencyMs: expect.any(Number),
        outcome: "upstream_error",
      });

      const successLogs: string[] = [];
      const successfulClient = createConnectWiseClient(credentials, {
        fetcher: async () => Response.json(testCase.validResponse),
        log: (line) => successLogs.push(line),
      });

      await expect(
        testCase.exercise(successfulClient),
        testCase.name,
      ).resolves.toEqual(testCase.expected);
      expect(successLogs, testCase.name).toHaveLength(1);
      expect(JSON.parse(successLogs[0]!), testCase.name).toEqual({
        event: "cw_request",
        method: "GET",
        status: 200,
        latencyMs: expect.any(Number),
        outcome: "success",
      });
    }
  });

  it("rejects an invalid ticket ID without making a request", async () => {
    let requests = 0;
    const client = createConnectWiseClient(credentials, {
      fetcher: async () => {
        requests += 1;
        return Response.json({});
      },
    });

    await expect(client.getServiceTicket(0)).rejects.toThrow(
      "Invalid service ticket ID",
    );
    expect(requests).toBe(0);
  });

  it("cancels upstream error bodies without retaining their contents", async () => {
    let attempts = 0;
    let cancelled = false;
    const sensitiveBody =
      '{"code":"Forbidden","message":"Access denied","privateKey":"secret value with spaces","token":"short"}' +
      "x".repeat(2_000_000);
    const client = createConnectWiseClient(credentials, {
      fetcher: async () => {
        attempts += 1;
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(sensitiveBody));
              // Deliberately never closes: failures must cancel without reading.
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 401 },
        );
      },
    });

    let error: unknown;
    try {
      await client.getServiceTicket(123);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConnectWiseRequestError);
    if (!(error instanceof ConnectWiseRequestError)) {
      throw new Error("Expected client error");
    }
    expect(error.message).toBe(
      "ConnectWise request failed (401) at GET /service/tickets/123",
    );
    expect(error.message).not.toContain("Forbidden");
    expect(error.message).not.toContain("Access denied");
    expect(error.message).not.toContain("secret value with spaces");
    expect(error.message).not.toContain("short");
    expect(error.diagnostics).toEqual({
      method: "GET",
      path: "/service/tickets/123",
    });
    expect(JSON.stringify(error.diagnostics)).not.toContain("Forbidden");
    expect(attempts).toBe(1);
    expect(cancelled).toBe(true);
  });

  it("audits malformed successful response bodies as upstream errors", async () => {
    const logs: string[] = [];
    const sensitiveBody = "sensitive malformed response";
    const client = createConnectWiseClient(credentials, {
      fetcher: async () => new Response(sensitiveBody),
      log: (line) => logs.push(line),
    });

    await expect(client.getServiceTicket(123)).rejects.toThrow(
      "Invalid ConnectWise response",
    );
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0]!)).toEqual({
      event: "cw_request",
      method: "GET",
      status: 200,
      latencyMs: expect.any(Number),
      outcome: "upstream_error",
    });
    expect(logs[0]).not.toContain(sensitiveBody);
    expect(logs[0]).not.toContain(credentials.privateKey);
  });

  it("audits empty successful response bodies as upstream errors", async () => {
    const logs: string[] = [];
    const client = createConnectWiseClient(credentials, {
      fetcher: async () => new Response(null, { status: 200 }),
      log: (line) => logs.push(line),
    });

    await expect(client.getServiceTicket(123)).rejects.toThrow(
      "Invalid ConnectWise response",
    );
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0]!)).toEqual({
      event: "cw_request",
      method: "GET",
      status: 200,
      latencyMs: expect.any(Number),
      outcome: "upstream_error",
    });
  });

  it("uses a bounded timeout and sanitizes abort failures", async () => {
    let attempts = 0;
    const client = createConnectWiseClient(credentials, {
      timeoutMs: 5,
      sleep: async () => undefined,
      fetcher: async (_input, init) => {
        attempts += 1;
        if (!init?.signal) throw new Error("missing bounded timeout");
        await new Promise<never>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new Error("request details must not escape")),
          );
        });
        throw new Error("unreachable");
      },
    });

    await expect(client.getServiceTicket(123)).rejects.toThrow(
      "ConnectWise request unavailable",
    );
    expect(attempts).toBe(2);
  });

  it("audits oversized response bodies as upstream errors", async () => {
    const logs: string[] = [];
    const client = createConnectWiseClient(credentials, {
      fetcher: async () =>
        new Response(JSON.stringify({ data: "x".repeat(1_000_001) }), {
          status: 200,
        }),
      log: (line) => logs.push(line),
    });

    await expect(client.getServiceTicket(123)).rejects.toThrow(
      "ConnectWise response too large",
    );
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0]!)).toEqual({
      event: "cw_request",
      method: "GET",
      status: 200,
      latencyMs: expect.any(Number),
      outcome: "upstream_error",
    });
    expect(logs[0]).not.toContain("xxx");
    expect(logs[0]).not.toContain(credentials.privateKey);
  });

  it("audits unreadable successful response streams as upstream errors", async () => {
    const logs: string[] = [];
    const client = createConnectWiseClient(credentials, {
      fetcher: async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.error(new Error("sensitive stream failure"));
            },
          }),
          { status: 200 },
        ),
      log: (line) => logs.push(line),
    });

    await expect(client.getServiceTicket(123)).rejects.toThrow(
      "ConnectWise response unavailable",
    );
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0]!)).toEqual({
      event: "cw_request",
      method: "GET",
      status: 200,
      latencyMs: expect.any(Number),
      outcome: "upstream_error",
    });
    expect(logs[0]).not.toContain("sensitive stream failure");
    expect(logs[0]).not.toContain(credentials.privateKey);
  });

  it("cancels a declared-oversized response body", async () => {
    let cancelled = false;
    const client = createConnectWiseClient(credentials, {
      fetcher: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { status: 200, headers: { "Content-Length": "1000001" } },
        ),
    });

    await expect(client.getServiceTicket(123)).rejects.toThrow(
      "ConnectWise response too large",
    );
    expect(cancelled).toBe(true);
  });

  it("keeps streamed-overflow cancellation failures sanitized", async () => {
    const client = createConnectWiseClient(credentials, {
      fetcher: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(1_000_001));
            },
            cancel() {
              throw new Error("sensitive cancellation details");
            },
          }),
          { status: 200 },
        ),
    });

    await expect(client.getServiceTicket(123)).rejects.toThrow(
      "ConnectWise response too large",
    );
  });

  it("accepts a JSON response at the stream chunk limit", async () => {
    const payload = new TextEncoder().encode('{"id":123}');
    const whitespace = new TextEncoder().encode(" ");
    const client = createConnectWiseClient(credentials, {
      fetcher: async () =>
        fragmentedResponse(payload, MAX_CONNECTWISE_RESPONSE_CHUNKS, {
          filler: whitespace,
        }),
    });

    await expect(client.getServiceTicket(123)).resolves.toEqual({ id: 123 });
  });

  it("cancels a fragmented JSON response beyond the stream chunk limit", async () => {
    let cancelled = false;
    const client = createConnectWiseClient(credentials, {
      fetcher: async () =>
        fragmentedResponse(
          new TextEncoder().encode('{"id":123}'),
          MAX_CONNECTWISE_RESPONSE_CHUNKS + 1,
          {
            filler: new TextEncoder().encode(" "),
            closeAfter: false,
            cancel: () => {
              cancelled = true;
              throw new Error("sensitive cancellation details");
            },
          },
        ),
    });

    await expect(client.getServiceTicket(123)).rejects.toThrow(
      "ConnectWise response too large",
    );
    expect(cancelled).toBe(true);
  });

  it.each([429, 502, 503, 504])(
    "audits a retried %s response before a successful safe retry",
    async (transientStatus) => {
      let attempts = 0;
      const delays: number[] = [];
      const logs: string[] = [];
      const sensitiveMarker = "sensitive-upstream-retry-body";
      const client = createConnectWiseClient(credentials, {
        fetcher: async () => {
          attempts += 1;
          if (attempts === 1) {
            return new Response(sensitiveMarker, { status: transientStatus });
          }
          return new Response(
            JSON.stringify({ id: 123, summary: "Recovered" }),
            { status: 200 },
          );
        },
        sleep: async (milliseconds) => {
          delays.push(milliseconds);
        },
        log: (line) => logs.push(line),
      });

      await expect(client.getServiceTicket(123)).resolves.toEqual({
        id: 123,
        summary: "Recovered",
      });
      expect(attempts).toBe(2);
      expect(delays).toEqual([100]);
      expect(logs).toHaveLength(2);
      expect(logs.join("\n")).not.toContain(sensitiveMarker);
      expect(logs.map((line) => JSON.parse(line))).toEqual([
        expect.objectContaining({
          event: "cw_request",
          method: "GET",
          status: transientStatus,
          outcome: "upstream_error",
        }),
        expect.objectContaining({
          event: "cw_request",
          method: "GET",
          status: 200,
          outcome: "success",
        }),
      ]);
    },
  );

  it("stops after two transient responses, audits both, and cancels both bodies", async () => {
    let attempts = 0;
    let cancellations = 0;
    const delays: number[] = [];
    const logs: string[] = [];
    const client = createConnectWiseClient(credentials, {
      fetcher: async () => {
        attempts += 1;
        return new Response(
          new ReadableStream({
            cancel() {
              cancellations += 1;
            },
          }),
          { status: 503 },
        );
      },
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
      log: (line) => logs.push(line),
    });

    await expect(client.getServiceTicket(123)).rejects.toThrow(
      "ConnectWise request failed (503)",
    );
    expect(attempts).toBe(2);
    expect(cancellations).toBe(2);
    expect(delays).toEqual([100]);
    expect(logs.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({
        event: "cw_request",
        method: "GET",
        status: 503,
        outcome: "upstream_error",
      }),
      expect.objectContaining({
        event: "cw_request",
        method: "GET",
        status: 503,
        outcome: "upstream_error",
      }),
    ]);
  });

  it("refuses get_my_member without a profile memberId and makes no request", async () => {
    let requests = 0;
    const client = createConnectWiseClient(
      {
        apiBaseUrl: "https://api-na.myconnectwise.net/v4_6_release/apis/3.0",
        companyId: "acme",
        publicKey: "public-key",
        privateKey: "private-key",
        clientId: "partner-client-id",
      },
      {
        fetcher: async () => {
          requests += 1;
          return Response.json({});
        },
      },
    );

    await expect(client.getMyMember()).rejects.toThrow(/missing memberId/);
    expect(requests).toBe(0);
  });

  it("gets only the authenticated member fields exposed by the tool", async () => {
    let capturedUrl = "";
    const member = {
      id: 149,
      name: "lrivera",
      firstName: "Luis",
      lastName: "Rivera",
      email: "luis@example.com",
      phone: "+1 555 0100",
      status: { id: 1, name: "Active" },
    };
    const client = createConnectWiseClient(credentials, {
      fetcher: async (input) => {
        capturedUrl = String(input);
        return Response.json(member);
      },
    });

    await expect(client.getMyMember()).resolves.toEqual(member);
    const url = new URL(capturedUrl);
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://api-na.myconnectwise.net/v4_6_release/apis/3.0/system/members/149",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      fields: memberDetailFields,
    });
    expect(url.searchParams.getAll("fields")).toEqual([memberDetailFields]);
  });

  it.each([
    null,
    [],
    {},
    { id: "149", name: "string-id" },
    { id: 150, name: "different-member" },
  ])(
    "rejects a member detail response outside the mapped profile: %j",
    async (member) => {
      const client = createConnectWiseClient(credentials, {
        fetcher: async () => Response.json(member),
      });

      await expect(client.getMyMember()).rejects.toThrow(
        "ConnectWise member response does not match mapped member",
      );
    },
  );

  it("uses a Workers-supported redirect mode and refuses 3xx responses", async () => {
    let attempts = 0;
    let redirectMode: string | undefined;
    const client = createConnectWiseClient(credentials, {
      fetcher: async (_input, init) => {
        attempts += 1;
        redirectMode = (init as { redirect?: string } | undefined)?.redirect;
        return new Response(null, {
          status: 302,
          headers: { Location: "https://evil.example/" },
        });
      },
      sleep: async () => undefined,
    });

    await expect(client.getServiceTicket(123)).rejects.toThrow(
      /redirected the request \(302\)/,
    );
    expect(redirectMode).toBe("manual");
    expect(attempts).toBe(1);
  });

  it("escapes ticket-search conditions and enforces targeted bounds", async () => {
    let capturedUrl = "";
    let fetchCount = 0;
    const client = createConnectWiseClient(credentials, {
      fetcher: async (input) => {
        fetchCount += 1;
        capturedUrl = String(input);
        return Response.json([]);
      },
    });

    await client.searchServiceTickets("  Luis's laptop  ", 12);
    const url = new URL(capturedUrl);
    expect(url.pathname).toBe("/v4_6_release/apis/3.0/service/tickets");
    expect(url.searchParams.get("conditions")).toBe(
      "summary contains 'Luis''s laptop'",
    );
    expect(url.searchParams.get("fields")).toBe(serviceTicketReadFields);
    expect(url.searchParams.getAll("fields")).toHaveLength(1);
    expect(url.searchParams.get("pageSize")).toBe("12");
    await expect(client.searchServiceTickets("x", 10)).rejects.toThrow(
      "Invalid ticket search text",
    );
    for (const searchText of ["\nprinter", "printer\t", "print\u007fer"]) {
      await expect(client.searchServiceTickets(searchText, 10)).rejects.toThrow(
        "Invalid ticket search text",
      );
    }
    await expect(client.searchServiceTickets("printer", 21)).rejects.toThrow(
      "Invalid targeted search page size",
    );
    expect(fetchCount).toBe(1);
  });

  it("verifies every ticket search result matches the requested summary", async () => {
    for (const { query, records } of [
      {
        query: "  Luis's laptop  ",
        records: [
          {
            id: 1,
            summary: "Repair LUIS'S LAPTOP",
            _info: { dateEntered: "2026-10-16T12:00:00Z" },
          },
          {
            id: 2,
            summary: "Luis's laptop replacement",
            _info: { dateEntered: "2026-10-15T12:00:00Z" },
          },
        ],
      },
      {
        query: "éx",
        records: [
          {
            id: 1,
            summary: "E\u0301xample printer",
            _info: { dateEntered: "2026-10-16T12:00:00Z" },
          },
        ],
      },
    ] as const) {
      const client = createConnectWiseClient(credentials, {
        fetcher: async () => Response.json(records),
      });
      await expect(client.searchServiceTickets(query, 20)).resolves.toEqual(
        records,
      );
    }

    const mismatchClient = createConnectWiseClient(credentials, {
      fetcher: async () =>
        Response.json([
          { id: 1, summary: "Printer outage" },
          { id: 2, summary: "Unrelated request" },
        ]),
    });
    await expect(
      mismatchClient.searchServiceTickets("printer", 20),
    ).rejects.toThrow(
      "ConnectWise record does not match targeted ticket search",
    );

    for (const summary of [undefined, null, 7, {}, []]) {
      const malformedClient = createConnectWiseClient(credentials, {
        fetcher: async () => Response.json([{ id: 1, summary }]),
      });
      await expect(
        malformedClient.searchServiceTickets("printer", 20),
      ).rejects.toThrow(
        "ConnectWise record does not match targeted ticket search",
      );
    }
  });

  it("rejects list responses that exceed dedicated and targeted bounds", async () => {
    const client = createConnectWiseClient(credentials, {
      fetcher: async (input) => {
        const requested = Number(
          new URL(String(input)).searchParams.get("pageSize"),
        );
        return Response.json(
          Array.from({ length: requested + 1 }, (_, index) => ({
            id: index + 1,
          })),
        );
      },
    });

    await expect(client.searchServiceTickets("printer", 20)).rejects.toThrow(
      "ConnectWise response exceeded requested page size",
    );
    await expect(client.searchMembers("printer", 20)).rejects.toThrow(
      "ConnectWise response exceeded requested page size",
    );
    await expect(client.getServiceBoards()).rejects.toThrow(
      "ConnectWise response exceeded requested page size",
    );

    const malformedOversized = createConnectWiseClient(credentials, {
      fetcher: async () =>
        Response.json([
          null,
          ...Array.from({ length: 20 }, (_, index) => ({ id: index + 1 })),
        ]),
    });
    await expect(
      malformedOversized.searchServiceTickets("printer", 20),
    ).rejects.toThrow("ConnectWise response exceeded requested page size");
  });

  it("audits bounded-list validation before recording request success", async () => {
    for (const { response, errorMessage, outcome } of [
      {
        response: [null],
        errorMessage: "Invalid ConnectWise list response",
        outcome: "upstream_error",
      },
      {
        response: Array.from({ length: 51 }, (_, index) => ({ id: index + 1 })),
        errorMessage: "ConnectWise response exceeded requested page size",
        outcome: "upstream_error",
      },
      {
        response: [{ id: 1 }],
        errorMessage: undefined,
        outcome: "success",
      },
    ] as const) {
      const logs: string[] = [];
      const client = createConnectWiseClient(credentials, {
        fetcher: async () => Response.json(response),
        log: (line) => logs.push(line),
      });

      if (errorMessage) {
        await expect(client.getServiceBoards()).rejects.toThrow(errorMessage);
      } else {
        await expect(client.getServiceBoards()).resolves.toEqual(response);
      }
      expect(logs).toHaveLength(1);
      expect(JSON.parse(logs[0]!)).toEqual({
        event: "cw_request",
        method: "GET",
        status: 200,
        latencyMs: expect.any(Number),
        outcome,
      });
    }
  });

  it("rejects malformed dedicated, targeted, and catalog list responses", async () => {
    const malformedResponses: unknown[] = [
      { value: [] },
      [null],
      ["unexpected"],
      [[]],
    ];

    for (const malformedResponse of malformedResponses) {
      const client = createConnectWiseClient(credentials, {
        fetcher: async () => Response.json(malformedResponse),
      });

      await expect(client.searchServiceTickets("printer", 10)).rejects.toThrow(
        "Invalid ConnectWise list response",
      );
      await expect(client.searchMembers("printer", 10)).rejects.toThrow(
        "Invalid ConnectWise list response",
      );
      await expect(client.getServiceBoards()).rejects.toThrow(
        "Invalid ConnectWise list response",
      );
      await expect(
        client.catalogGet("finance.agreements.byName", {
          name: "Managed",
          pageSize: 10,
        }),
      ).rejects.toThrow("Invalid ConnectWise list response");
    }
  });

  it("classifies an ambiguous ticket-note fetch failure without retrying", async () => {
    let attempts = 0;
    const client = createConnectWiseClient(credentials, {
      sleep: async () => undefined,
      fetcher: async () => {
        attempts += 1;
        throw new Error("ambiguous network failure");
      },
    });

    await expect(
      client.createTicketNote(123, {
        text: "Customer called",
        internalOnly: true,
        resolutionNote: false,
        issueNote: false,
      }),
    ).rejects.toBeInstanceOf(ConnectWiseIndeterminateWriteError);
    expect(attempts).toBe(1);
  });

  it.each([
    ["an upstream timeout response", () => new Response(null, { status: 408 })],
    ["an upstream server error", () => new Response(null, { status: 503 })],
    [
      "an accepted asynchronous response",
      () => Response.json({ id: 9, ticketId: 123 }, { status: 202 }),
    ],
    ["an empty success response", () => new Response(null)],
    ["a malformed success response", () => new Response("not json")],
    [
      "an oversized success response",
      () =>
        new Response("{}", {
          headers: { "Content-Length": "1000001" },
        }),
    ],
    [
      "an unreadable success response",
      () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.error(new Error("sensitive stream failure"));
            },
          }),
        ),
    ],
  ])(
    "classifies %s after a write as indeterminate",
    async (_label, response) => {
      let attempts = 0;
      const client = createConnectWiseClient(credentials, {
        fetcher: async () => {
          attempts += 1;
          return response();
        },
      });

      await expect(
        client.createTicketNote(123, {
          text: "Customer called",
          internalOnly: true,
          resolutionNote: false,
          issueNote: false,
        }),
      ).rejects.toBeInstanceOf(ConnectWiseIndeterminateWriteError);
      expect(attempts).toBe(1);
    },
  );

  it.each([
    [400, ConnectWiseRequestError],
    [429, ConnectWiseRequestError],
  ])(
    "preserves an explicit POST rejection with status %i",
    async (status, type) => {
      const client = createConnectWiseClient(credentials, {
        fetcher: async () => new Response(null, { status }),
      });

      await expect(
        client.createTicketNote(123, {
          text: "Customer called",
          internalOnly: true,
          resolutionNote: false,
          issueNote: false,
        }),
      ).rejects.toBeInstanceOf(type);
    },
  );

  it("classifies a POST redirect as indeterminate", async () => {
    const client = createConnectWiseClient(credentials, {
      fetcher: async () => new Response(null, { status: 302 }),
    });

    await expect(
      client.createTicketNote(123, {
        text: "Customer called",
        internalOnly: true,
        resolutionNote: false,
        issueNote: false,
      }),
    ).rejects.toBeInstanceOf(ConnectWiseIndeterminateWriteError);
  });

  it("classifies a wrong-target ticket-note receipt as indeterminate", async () => {
    const client = createConnectWiseClient(credentials, {
      fetcher: async () => Response.json({ id: 9, ticketId: 124 }),
    });

    await expect(
      client.createTicketNote(123, {
        text: "Customer called",
        internalOnly: true,
        resolutionNote: false,
        issueNote: false,
      }),
    ).rejects.toBeInstanceOf(ConnectWiseIndeterminateWriteError);
  });

  it("classifies a wrong-target attachment receipt as indeterminate", async () => {
    const client = createConnectWiseClient(credentials, {
      fetcher: async () =>
        Response.json({ id: 9, recordId: 123, recordType: "TimeEntry" }),
    });

    await expect(
      client.attachImageToTicket(123, {
        filename: "router.png",
        base64: "iVBORw0KGgo=",
        mimeType: "image/png",
      }),
    ).rejects.toBeInstanceOf(ConnectWiseIndeterminateWriteError);
  });

  it("requests only projected fields for an agreement record", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const client = createConnectWiseClient(credentials, {
      fetcher: async (input, init) => {
        capturedUrl = String(input);
        capturedInit = init;
        return Response.json({ id: 7 });
      },
    });

    await expect(client.getAgreement(7)).resolves.toEqual({ id: 7 });

    const agreementUrl = new URL(capturedUrl);
    expect(agreementUrl.pathname).toBe(
      "/v4_6_release/apis/3.0/finance/agreements/7",
    );
    expect(capturedInit?.method).toBe("GET");
    expect(Object.fromEntries(agreementUrl.searchParams)).toEqual({
      fields: agreementCollectionFields,
    });
    expect(agreementUrl.searchParams.getAll("fields")).toHaveLength(1);
  });

  it("rejects malformed or mismatched agreement responses", async () => {
    const invalidAgreements: unknown[] = [
      null,
      [],
      {},
      { id: "7" },
      { id: 8, name: "Wrong agreement" },
    ];

    for (const invalidAgreement of invalidAgreements) {
      const client = createConnectWiseClient(credentials, {
        fetcher: async () => Response.json(invalidAgreement),
      });

      await expect(client.getAgreement(7)).rejects.toThrow(
        "ConnectWise agreement does not match requested ID",
      );
    }
  });

  it("verifies agreement relationships and returns projected additions", async () => {
    let capturedUrl = "";
    const client = createConnectWiseClient(credentials, {
      fetcher: async (input) => {
        capturedUrl = String(input);
        return Response.json([
          { id: 44, description: "Managed service", agreementId: 7 },
        ]);
      },
    });

    await expect(client.getAgreementAdditions(7, 5)).resolves.toEqual([
      { id: 44, description: "Managed service" },
    ]);

    const additionsUrl = new URL(capturedUrl);
    expect(additionsUrl.pathname).toBe(
      "/v4_6_release/apis/3.0/finance/agreements/7/additions",
    );
    expect(Object.fromEntries(additionsUrl.searchParams)).toEqual({
      fields: agreementAdditionCollectionFields,
      pageSize: "5",
    });
    expect(additionsUrl.searchParams.getAll("fields")).toHaveLength(1);
  });

  it("applies agreement addition filters before the bounded result page", async () => {
    let capturedUrl = "";
    const client = createConnectWiseClient(credentials, {
      fetcher: async (input) => {
        capturedUrl = String(input);
        return Response.json([
          {
            id: 44,
            product: { id: 8, name: "LUIS'S SERVICE PREMIUM" },
            effectiveDate: "2026-09-15T00:00:00Z",
            agreementId: 7,
          },
        ]);
      },
    });

    await expect(
      client.searchAgreementAdditions(
        7,
        {
          productName: "Luis's service",
          dateFrom: "2026-09-01",
          dateTo: "2026-09-30",
        },
        5,
      ),
    ).resolves.toEqual([
      {
        id: 44,
        product: { id: 8, name: "LUIS'S SERVICE PREMIUM" },
        effectiveDate: "2026-09-15T00:00:00Z",
      },
    ]);

    const additionsUrl = new URL(capturedUrl);
    expect(additionsUrl.pathname).toBe(
      "/v4_6_release/apis/3.0/finance/agreements/7/additions",
    );
    expect(Object.fromEntries(additionsUrl.searchParams)).toEqual({
      conditions:
        "product/name like '%Luis''s service%' and effectiveDate >= [2026-09-01] and effectiveDate <= [2026-09-30T23:59:59]",
      fields: agreementAdditionCollectionFields,
      pageSize: "5",
      orderBy: "effectiveDate desc",
    });
  });

  it("rejects unsafe agreement addition filters before requesting data", async () => {
    let fetchCount = 0;
    const client = createConnectWiseClient(credentials, {
      fetcher: async () => {
        fetchCount += 1;
        return Response.json([]);
      },
    });

    const invalidFilters = [
      { productName: "x" },
      { productName: "managed%service" },
      { productName: "managed_service" },
      { productName: "managed\nservice" },
      { dateFrom: "2026-02-30" },
      { dateTo: "09/30/2026" },
      { dateFrom: "2026-10-01", dateTo: "2026-09-30" },
    ];
    for (const filters of invalidFilters) {
      await expect(
        client.searchAgreementAdditions(7, filters, 5),
      ).rejects.toThrow();
    }
    expect(fetchCount).toBe(0);
  });

  it("fails closed when agreement additions do not match requested filters", async () => {
    const productMismatch = createConnectWiseClient(credentials, {
      fetcher: async () =>
        Response.json([
          {
            id: 1,
            product: { name: "Managed service" },
            effectiveDate: "2026-09-15T00:00:00Z",
            agreementId: 7,
          },
          {
            id: 2,
            product: { name: "Cloud backup" },
            effectiveDate: "2026-09-16T00:00:00Z",
            agreementId: 7,
          },
        ]),
    });
    await expect(
      productMismatch.searchAgreementAdditions(
        7,
        { productName: "managed" },
        5,
      ),
    ).rejects.toThrow("does not match requested product");

    const relationshipMismatch = createConnectWiseClient(credentials, {
      fetcher: async () =>
        Response.json([
          {
            id: 1,
            product: { name: "Managed service" },
            agreementId: 7,
          },
          {
            id: 2,
            product: { name: "Managed service premium" },
            agreementId: 8,
          },
        ]),
    });
    await expect(
      relationshipMismatch.searchAgreementAdditions(
        7,
        { productName: "managed" },
        5,
      ),
    ).rejects.toThrow("is not associated with requested agreement");

    for (const effectiveDate of [
      "2026-08-31T23:59:59Z",
      "2026-10-01T00:00:00Z",
      "2026-02-30T00:00:00Z",
      "2026-09-15-not-a-date",
      "2026-09-15T99:99:99Z",
      null,
    ]) {
      const dateMismatch = createConnectWiseClient(credentials, {
        fetcher: async () =>
          Response.json([{ id: 1, effectiveDate, agreementId: 7 }]),
      });
      await expect(
        dateMismatch.searchAgreementAdditions(
          7,
          { dateFrom: "2026-09-01", dateTo: "2026-09-30" },
          5,
        ),
      ).rejects.toThrow("outside requested effective date range");
    }
  });

  it("verifies agreement relationships and returns aggregate addition fields", async () => {
    let capturedUrl = "";
    const client = createConnectWiseClient(credentials, {
      fetcher: async (input) => {
        capturedUrl = String(input);
        return Response.json([{ extPrice: 25, extCost: 10, agreementId: 7 }]);
      },
    });

    await expect(client.getAgreementAdditionSummary(7, 5)).resolves.toEqual([
      { extPrice: 25, extCost: 10 },
    ]);

    const summaryUrl = new URL(capturedUrl);
    expect(summaryUrl.pathname).toBe(
      "/v4_6_release/apis/3.0/finance/agreements/7/additions",
    );
    expect(Object.fromEntries(summaryUrl.searchParams)).toEqual({
      fields: agreementAdditionSummaryFields,
      pageSize: "5",
    });
  });

  it.each([
    {},
    { agreementId: null },
    { agreementId: "7" },
    { agreementId: 8 },
  ])(
    "rejects additions outside the exact requested agreement: %j",
    async (addition) => {
      const client = createConnectWiseClient(credentials, {
        fetcher: async () => Response.json([addition]),
      });

      for (const read of [
        () => client.getAgreementAdditions(7, 5),
        () => client.getAgreementAdditionSummary(7, 5),
      ]) {
        await expect(read()).rejects.toThrow(
          "ConnectWise addition is not associated with requested agreement",
        );
      }
    },
  );

  it("verifies and strips agreement relationships from recent invoices", async () => {
    const urls: string[] = [];
    const client = createConnectWiseClient(credentials, {
      fetcher: async (input) => {
        urls.push(String(input));
        return Response.json([
          {
            id: 91,
            invoiceNumber: "INV-91",
            total: 125,
            agreement: { id: 7 },
          },
        ]);
      },
    });

    await expect(client.getRecentAgreementInvoices(7, 5)).resolves.toEqual([
      { id: 91, invoiceNumber: "INV-91", total: 125 },
    ]);

    const invoicesUrl = new URL(urls[0]!);
    expect(invoicesUrl.pathname).toBe(
      "/v4_6_release/apis/3.0/finance/invoices",
    );
    expect(Object.fromEntries(invoicesUrl.searchParams)).toEqual({
      conditions: "agreement/id=7",
      fields: agreementInvoiceCollectionFields,
      pageSize: "5",
      orderBy: "date desc",
    });
    expect(invoicesUrl.searchParams.getAll("fields")).toHaveLength(1);
  });

  it.each([
    { id: 91, agreement: { id: 8 } },
    { id: 91 },
    { id: 91, agreement: null },
    { id: 91, agreement: [] },
    { id: 91, agreement: { id: "7" } },
  ])(
    "rejects an invoice without the exact requested agreement relationship: %j",
    async (invoice) => {
      const client = createConnectWiseClient(credentials, {
        fetcher: async () => Response.json([invoice]),
      });

      await expect(client.getRecentAgreementInvoices(7, 5)).rejects.toThrow(
        "ConnectWise invoice is not associated with requested agreement",
      );
    },
  );

  it("sends a fixed agreement-addition payload without caller-selected paths", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const client = createConnectWiseClient(credentials, {
      fetcher: async (input, init) => {
        capturedUrl = String(input);
        capturedInit = init;
        return Response.json({
          id: 44,
          agreementId: 7,
          product: { id: 8 },
        });
      },
    });

    await client.createAgreementAddition(7, {
      productId: 8,
      quantity: 2,
      unitPrice: 15.5,
      effectiveDate: "2026-08-28",
      description: "Managed service",
      billableOption: "Billable",
    });

    expect(capturedUrl).toBe(
      "https://api-na.myconnectwise.net/v4_6_release/apis/3.0/finance/agreements/7/additions",
    );
    expect(capturedInit?.method).toBe("POST");
    expect(JSON.parse(String(capturedInit?.body))).toEqual({
      product: { id: 8 },
      quantity: 2,
      unitPrice: 15.5,
      effectiveDate: "2026-08-28",
      billableOption: "Billable",
      description: "Managed service",
    });
  });

  it.each([
    null,
    [],
    {},
    { id: 0, agreementId: 7, product: { id: 8 } },
    { id: "44", agreementId: 7, product: { id: 8 } },
    { id: 44, product: { id: 8 } },
    { id: 44, agreementId: "7", product: { id: 8 } },
    { id: 44, agreementId: 9, product: { id: 8 } },
    { id: 44, agreementId: 7 },
    { id: 44, agreementId: 7, product: [] },
    { id: 44, agreementId: 7, product: { id: "8" } },
    { id: 44, agreementId: 7, product: { id: 9 } },
  ])(
    "rejects an unverified created agreement addition: %j",
    async (response) => {
      const client = createConnectWiseClient(credentials, {
        fetcher: async () => Response.json(response),
      });

      await expect(
        client.createAgreementAddition(7, {
          productId: 8,
          quantity: 2,
          unitPrice: 15.5,
          effectiveDate: "2026-08-28",
          billableOption: "Billable",
        }),
      ).rejects.toBeInstanceOf(ConnectWiseIndeterminateWriteError);
    },
  );

  it("builds fixed board, lookup, and member read routes", async () => {
    const urls: string[] = [];
    const client = createConnectWiseClient(credentials, {
      fetcher: async (input) => {
        const url = String(input);
        urls.push(url);
        return Response.json(
          new URL(url).pathname.endsWith("/system/members/149")
            ? { id: 149 }
            : [],
        );
      },
    });

    await client.getServiceBoards();
    expect(new URL(urls[0]!).searchParams.get("orderBy")).toBe("name asc");
    expect(new URL(urls[0]!).pathname).toBe(
      "/v4_6_release/apis/3.0/service/boards",
    );

    await client.getBoardStatuses(32);
    expect(new URL(urls[1]!).pathname).toBe(
      "/v4_6_release/apis/3.0/service/boards/32/statuses",
    );
    expect(new URL(urls[1]!).searchParams.get("pageSize")).toBe("50");

    await client.getBoardTypes(32);
    expect(new URL(urls[2]!).pathname).toBe(
      "/v4_6_release/apis/3.0/service/boards/32/types",
    );
    expect(new URL(urls[2]!).searchParams.get("pageSize")).toBe("50");

    await client.listBoardTickets(32, 10);
    expect(new URL(urls[3]!).searchParams.get("conditions")).toBe(
      "board/id=32",
    );
    expect(new URL(urls[3]!).searchParams.get("fields")).toBe(
      serviceTicketReadFields,
    );

    await client.getServiceStatuses();
    expect(new URL(urls[4]!).pathname).toBe(
      "/v4_6_release/apis/3.0/service/statuses",
    );

    await client.getMyMember();
    expect(new URL(urls[5]!).pathname).toBe(
      "/v4_6_release/apis/3.0/system/members/149",
    );

    await client.listTimeEntries(5);
    expect(new URL(urls[6]!).pathname).toBe(
      "/v4_6_release/apis/3.0/time/entries",
    );
    expect(new URL(urls[6]!).searchParams.get("conditions")).toBe(
      "member/id=149",
    );
    expect(new URL(urls[6]!).searchParams.getAll("fields")).toEqual([
      timeEntryReadFields,
    ]);
    expect(new URL(urls[6]!).searchParams.get("pageSize")).toBe("5");
  });

  it("verifies every board-ticket result belongs to the requested board", async () => {
    const matchingTicket = {
      id: 1,
      board: { id: 32 },
      _info: { dateEntered: "2026-10-16T12:00:00Z" },
    };
    const matchingClient = createConnectWiseClient(credentials, {
      fetcher: async () => Response.json([matchingTicket]),
    });
    await expect(matchingClient.listBoardTickets(32, 10)).resolves.toEqual([
      matchingTicket,
    ]);

    const laterMismatchClient = createConnectWiseClient(credentials, {
      fetcher: async () =>
        Response.json([
          { id: 1, board: { id: 32 } },
          { id: 2, board: { id: 33 } },
        ]),
    });
    await expect(laterMismatchClient.listBoardTickets(32, 10)).rejects.toThrow(
      "ConnectWise record does not match requested board",
    );

    for (const board of [undefined, null, [], {}, { id: "32" }, { id: 33 }]) {
      const client = createConnectWiseClient(credentials, {
        fetcher: async () => Response.json([{ id: 1, board }]),
      });
      await expect(client.listBoardTickets(32, 10)).rejects.toThrow(
        "ConnectWise record does not match requested board",
      );
    }
  });

  it.each([
    { name: "missing", option: { name: "New" } },
    { name: "string", option: { id: "7", name: "New" } },
    { name: "zero", option: { id: 0, name: "New" } },
    { name: "negative", option: { id: -1, name: "New" } },
    { name: "fractional", option: { id: 1.5, name: "New" } },
    {
      name: "unsafe integer",
      option: { id: Number.MAX_SAFE_INTEGER + 1, name: "New" },
    },
  ])("rejects reference records with a $name ID", async ({ option }) => {
    const createClient = () =>
      createConnectWiseClient(credentials, {
        fetcher: async () => Response.json([option]),
      });
    const expectedError = "Invalid ConnectWise reference response";

    await expect(createClient().getServiceBoards()).rejects.toThrow(
      expectedError,
    );
    await expect(createClient().getBoardStatuses(32)).rejects.toThrow(
      expectedError,
    );
    await expect(createClient().getBoardTypes(32)).rejects.toThrow(
      expectedError,
    );
    await expect(createClient().getServiceStatuses()).rejects.toThrow(
      expectedError,
    );
    await expect(createClient().getServicePriorities()).rejects.toThrow(
      expectedError,
    );
    await expect(createClient().getServiceSources()).rejects.toThrow(
      expectedError,
    );
    await expect(
      createClient().catalogGet("service.boards.statuses", { boardId: 32 }),
    ).rejects.toThrow(expectedError);
    await expect(
      createClient().catalogGet("service.boards.types", { boardId: 32 }),
    ).rejects.toThrow(expectedError);
  });

  it("preserves reference records with positive safe-integer IDs", async () => {
    const options = [
      { id: 1, name: "New" },
      { id: Number.MAX_SAFE_INTEGER, name: "Escalated" },
    ];
    const client = createConnectWiseClient(credentials, {
      fetcher: async () => Response.json(options),
    });

    await expect(client.getServiceBoards()).resolves.toEqual(options);
    await expect(client.getBoardStatuses(32)).resolves.toEqual(options);
    await expect(client.getBoardTypes(32)).resolves.toEqual(options);
    await expect(client.getServiceStatuses()).resolves.toEqual(options);
    await expect(client.getServicePriorities()).resolves.toEqual(options);
    await expect(client.getServiceSources()).resolves.toEqual(options);
    await expect(
      client.catalogGet("service.boards.statuses", { boardId: 32 }),
    ).resolves.toEqual(options);
    await expect(
      client.catalogGet("service.boards.types", { boardId: 32 }),
    ).resolves.toEqual(options);
  });

  it("minimizes documented board and reference collections upstream", async () => {
    const urls: string[] = [];
    const client = createConnectWiseClient(credentials, {
      fetcher: async (input) => {
        urls.push(String(input));
        return Response.json([]);
      },
    });

    await client.getServiceBoards();
    await client.getBoardStatuses(32);
    await client.getBoardTypes(32);
    await client.getServiceStatuses();
    await client.getServicePriorities();
    await client.getServiceSources();
    await client.catalogGet("service.boards.statuses", {
      boardId: 32,
      pageSize: 5,
    });
    await client.catalogGet("service.boards.types", { boardId: 32 });

    expect(urls).toHaveLength(8);
    expect(Object.fromEntries(new URL(urls[0]!).searchParams)).toEqual({
      fields: serviceBoardCollectionFields,
      orderBy: "name asc",
      pageSize: "50",
    });
    expect(Object.fromEntries(new URL(urls[1]!).searchParams)).toEqual({
      fields: boardStatusCollectionFields,
      pageSize: "50",
    });
    expect(Object.fromEntries(new URL(urls[2]!).searchParams)).toEqual({
      fields: boardTypeCollectionFields,
      pageSize: "50",
    });
    expect(Object.fromEntries(new URL(urls[3]!).searchParams)).toEqual({
      fields: serviceStatusCollectionFields,
      orderBy: "name asc",
      pageSize: "50",
    });
    expect(Object.fromEntries(new URL(urls[4]!).searchParams)).toEqual({
      fields: servicePriorityCollectionFields,
      orderBy: "name asc",
      pageSize: "50",
    });
    expect(Object.fromEntries(new URL(urls[5]!).searchParams)).toEqual({
      fields: serviceSourceCollectionFields,
      orderBy: "name asc",
      pageSize: "50",
    });
    expect(Object.fromEntries(new URL(urls[6]!).searchParams)).toEqual({
      fields: boardStatusCollectionFields,
      pageSize: "5",
    });
    expect(Object.fromEntries(new URL(urls[7]!).searchParams)).toEqual({
      fields: boardTypeCollectionFields,
      pageSize: "20",
    });
    for (const url of urls) {
      expect(new URL(url).searchParams.getAll("fields")).toHaveLength(1);
    }
  });

  it("refuses time-entry listing without a profile member ID", async () => {
    let requests = 0;
    const credentialsWithoutMember = { ...credentials };
    delete credentialsWithoutMember.memberId;
    const client = createConnectWiseClient(credentialsWithoutMember, {
      fetcher: async () => {
        requests += 1;
        return Response.json([]);
      },
    });

    await expect(client.listTimeEntries(5)).rejects.toThrow(
      "ConnectWise profile is missing memberId; add it to enable list_time_entries",
    );
    expect(requests).toBe(0);
  });

  it("searches members by a required bounded name query", async () => {
    const urls: string[] = [];
    const client = createConnectWiseClient(credentials, {
      fetcher: async (input) => {
        urls.push(String(input));
        return Response.json([]);
      },
    });

    await client.searchMembers("  O'Brien  ", 20);
    const url = new URL(urls[0]!);
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://api-na.myconnectwise.net/v4_6_release/apis/3.0/system/members",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      conditions: "name like '%O''Brien%'",
      fields: "id,name,status",
      orderBy: "name asc",
      pageSize: "20",
    });
    expect(url.searchParams.getAll("fields")).toEqual(["id,name,status"]);

    for (const query of ["", " ", "x", "%%", "A_", "x".repeat(101), "ok\nno"]) {
      await expect(client.searchMembers(query, 10)).rejects.toThrow(
        /Invalid .*search text/,
      );
    }
    for (const pageSize of [0, 21, 1.5]) {
      await expect(client.searchMembers("valid", pageSize)).rejects.toThrow(
        "Invalid targeted search page size",
      );
    }
    expect(urls).toHaveLength(1);
  });

  it("requires targeted company and contact searches", async () => {
    const urls: string[] = [];
    const client = createConnectWiseClient(credentials, {
      fetcher: async (input) => {
        urls.push(String(input));
        return Response.json([]);
      },
    });

    await client.searchCompanies("  O'Brien  ", 20);
    const companyUrl = new URL(urls[0]!);
    expect(`${companyUrl.origin}${companyUrl.pathname}`).toBe(
      "https://api-na.myconnectwise.net/v4_6_release/apis/3.0/company/companies",
    );
    expect(Object.fromEntries(companyUrl.searchParams)).toEqual({
      conditions: "name like '%O''Brien%'",
      fields: "id,name,phoneNumber,addressLine1,status",
      orderBy: "name asc",
      pageSize: "20",
    });
    expect(companyUrl.searchParams.getAll("fields")).toEqual([
      "id,name,phoneNumber,addressLine1,status",
    ]);

    await client.searchContacts("a@b.com", 20);
    const contactUrl = new URL(urls[1]!);
    expect(`${contactUrl.origin}${contactUrl.pathname}`).toBe(
      "https://api-na.myconnectwise.net/v4_6_release/apis/3.0/company/contacts",
    );
    expect(Object.fromEntries(contactUrl.searchParams)).toEqual({
      conditions: "(name like '%a@b.com%' OR email like '%a@b.com%')",
      fields: "id,name,firstName,lastName,title,phone,cellPhone,email,company",
      orderBy: "name asc",
      pageSize: "20",
    });
    expect(contactUrl.searchParams.getAll("fields")).toEqual([
      "id,name,firstName,lastName,title,phone,cellPhone,email,company",
    ]);

    for (const query of ["", " ", "x", "%", "A_", "x".repeat(101), "ok\nno"]) {
      await expect(client.searchCompanies(query, 10)).rejects.toThrow(
        /Invalid .*search text/,
      );
      await expect(client.searchContacts(query, 10)).rejects.toThrow(
        /Invalid .*search text/,
      );
    }
    for (const pageSize of [0, 21, 1.5]) {
      await expect(client.searchCompanies("valid", pageSize)).rejects.toThrow(
        "Invalid targeted search page size",
      );
      await expect(client.searchContacts("valid", pageSize)).rejects.toThrow(
        "Invalid targeted search page size",
      );
    }
    expect(urls).toHaveLength(2);
  });

  it("verifies every targeted member and company result matches the requested name", async () => {
    for (const { query, records, search } of [
      {
        query: "  O'Brien  ",
        records: [
          { id: 1, name: "Pat O'BRIEN" },
          { id: 2, name: "O'Brien, Sam" },
        ],
        search: "members",
      },
      {
        query: "éx",
        records: [{ id: 1, name: "E\u0301xample Systems" }],
        search: "companies",
      },
    ] as const) {
      const client = createConnectWiseClient(credentials, {
        fetcher: async () => Response.json(records),
      });
      const result =
        search === "members"
          ? client.searchMembers(query, 20)
          : client.searchCompanies(query, 20);
      await expect(result).resolves.toEqual(records);
    }

    for (const search of ["members", "companies"] as const) {
      const mismatchClient = createConnectWiseClient(credentials, {
        fetcher: async () =>
          Response.json([
            { id: 1, name: "Alice Example" },
            { id: 2, name: "Unrelated" },
          ]),
      });
      const mismatchResult =
        search === "members"
          ? mismatchClient.searchMembers("Alice", 20)
          : mismatchClient.searchCompanies("Alice", 20);
      await expect(mismatchResult).rejects.toThrow(
        "ConnectWise record does not match targeted name search",
      );

      for (const name of [undefined, null, 7, {}, []]) {
        const malformedClient = createConnectWiseClient(credentials, {
          fetcher: async () => Response.json([{ id: 1, name }]),
        });
        const malformedResult =
          search === "members"
            ? malformedClient.searchMembers("valid", 20)
            : malformedClient.searchCompanies("valid", 20);
        await expect(malformedResult).rejects.toThrow(
          "ConnectWise record does not match targeted name search",
        );
      }
    }
  });

  it("verifies every targeted contact result matches the requested name or email", async () => {
    for (const { query, records } of [
      {
        query: "  O'Brien  ",
        records: [
          { id: 1, name: "Pat O'BRIEN", email: "pat@example.com" },
          { id: 2, name: "O'Brien, Sam", email: null },
        ],
      },
      {
        query: "éx",
        records: [{ id: 1, name: "Other", email: "team@e\u0301xample.com" }],
      },
      {
        query: "a@b.com",
        records: [{ id: 1, email: "A@B.COM" }],
      },
    ] as const) {
      const client = createConnectWiseClient(credentials, {
        fetcher: async () => Response.json(records),
      });
      await expect(client.searchContacts(query, 20)).resolves.toEqual(records);
    }

    const mismatchClient = createConnectWiseClient(credentials, {
      fetcher: async () =>
        Response.json([
          { id: 1, name: "Alice Example", email: "alice@example.com" },
          { id: 2, name: "Unrelated", email: "other@example.net" },
        ]),
    });
    await expect(mismatchClient.searchContacts("Alice", 20)).rejects.toThrow(
      "ConnectWise record does not match targeted contact search",
    );

    for (const fields of [
      {},
      { name: null, email: null },
      { name: 7, email: {} },
      { name: [], email: false },
    ]) {
      const malformedClient = createConnectWiseClient(credentials, {
        fetcher: async () => Response.json([{ id: 1, ...fields }]),
      });
      await expect(malformedClient.searchContacts("valid", 20)).rejects.toThrow(
        "ConnectWise record does not match targeted contact search",
      );
    }
  });

  it("builds allowlisted catalog routes and rejects unknown ones", async () => {
    const urls: string[] = [];
    const client = createConnectWiseClient(credentials, {
      fetcher: async (input) => {
        urls.push(String(input));
        return Response.json([]);
      },
    });

    await client.catalogGet("service.tickets.byStatus", {
      statusId: 547,
      pageSize: 20,
    });
    expect(new URL(urls[0]!).searchParams.get("conditions")).toBe(
      "status/id=547",
    );
    expect(new URL(urls[0]!).searchParams.get("fields")).toBe(
      serviceTicketReadFields,
    );
    expect(new URL(urls[0]!).searchParams.get("orderBy")).toBe(
      "dateEntered desc",
    );

    await client.catalogGet("system.documents", {
      recordType: "Ticket",
      recordId: 77,
      pageSize: 20,
    });
    expect(new URL(urls[1]!).searchParams.get("recordType")).toBe("Ticket");
    expect(new URL(urls[1]!).searchParams.get("recordId")).toBe("77");
    expect(new URL(urls[1]!).searchParams.getAll("fields")).toEqual([
      ticketAttachmentCollectionFields,
    ]);

    await expect(
      client.catalogGet("finance.invoices.byRaw", { pageSize: 5 }),
    ).rejects.toThrow("Unknown ConnectWise route");

    await expect(
      client.catalogGet("system.documents", { recordType: "Raw", recordId: 7 }),
    ).rejects.toThrow("Unsupported document record type");

    await expect(
      client.catalogGet("service.boards.statuses", { pageSize: 5 }),
    ).rejects.toThrow("Missing boardId");

    await expect(
      client.catalogGet("service.boards.statuses", {
        boardId: 32,
        query: "ignored before hardening",
      }),
    ).rejects.toThrow(
      "Parameter query is not allowed for route service.boards.statuses",
    );
  });

  it.each([
    ["service.boards.statuses", "boardId", "32"],
    ["service.boards.types", "boardId", "32/statuses"],
    ["service.tickets.byStatus", "statusId", "1 OR closedFlag=false"],
    ["system.documents", "recordId", "77&recordType=Company"],
    ["time.entries.byMember", "memberId", "149"],
  ] as const)(
    "rejects non-numeric catalog identifier %s.%s before requesting upstream",
    async (route, key, value) => {
      let requests = 0;
      const client = createConnectWiseClient(credentials, {
        fetcher: async () => {
          requests += 1;
          return Response.json([]);
        },
      });

      await expect(
        client.catalogGet(route, { [key]: value, pageSize: 20 }),
      ).rejects.toThrow(/Invalid (boardId|statusId|recordId)|Catalog memberId/);
      expect(requests).toBe(0);
    },
  );

  it.each([
    ["company.configurations", "query"],
    ["finance.agreements.byName", "name"],
  ] as const)(
    "rejects non-string catalog search parameter %s.%s before requesting upstream",
    async (route, key) => {
      let requests = 0;
      const client = createConnectWiseClient(credentials, {
        fetcher: async () => {
          requests += 1;
          return Response.json([]);
        },
      });

      await expect(
        client.catalogGet(route, { [key]: 7, pageSize: 20 }),
      ).rejects.toThrow(`Invalid ${key}`);
      expect(requests).toBe(0);
    },
  );

  it("verifies every status-filtered ticket matches the requested status", async () => {
    const matchingTicket = {
      id: 1,
      status: { id: 547 },
      _info: { dateEntered: "2026-10-16T12:00:00Z" },
    };
    const matchingClient = createConnectWiseClient(credentials, {
      fetcher: async () => Response.json([matchingTicket]),
    });
    await expect(
      matchingClient.catalogGet("service.tickets.byStatus", { statusId: 547 }),
    ).resolves.toEqual([matchingTicket]);

    const laterMismatchClient = createConnectWiseClient(credentials, {
      fetcher: async () =>
        Response.json([
          { id: 1, status: { id: 547 } },
          { id: 2, status: { id: 548 } },
        ]),
    });
    await expect(
      laterMismatchClient.catalogGet("service.tickets.byStatus", {
        statusId: 547,
      }),
    ).rejects.toThrow("ConnectWise record does not match requested status");

    for (const status of [
      undefined,
      null,
      [],
      {},
      { id: "547" },
      { id: 548 },
    ]) {
      const client = createConnectWiseClient(credentials, {
        fetcher: async () => Response.json([{ id: 1, status }]),
      });
      await expect(
        client.catalogGet("service.tickets.byStatus", { statusId: 547 }),
      ).rejects.toThrow("ConnectWise record does not match requested status");
    }
  });

  it("requires targeted catalog name searches", async () => {
    const urls: string[] = [];
    const client = createConnectWiseClient(credentials, {
      fetcher: async (input) => {
        urls.push(String(input));
        return Response.json([]);
      },
    });

    await client.catalogGet("company.configurations", {
      query: "  O'Brien  ",
      pageSize: 20,
    });
    const configurationUrl = new URL(urls[0]!);
    expect(configurationUrl.searchParams.get("conditions")).toBe(
      "name like '%O''Brien%'",
    );
    expect(configurationUrl.searchParams.getAll("fields")).toEqual([
      configurationCollectionFields,
    ]);
    expect(configurationUrl.searchParams.getAll("pageSize")).toEqual(["20"]);

    await client.catalogGet("finance.agreements.byName", {
      name: "Managed Services",
      pageSize: 20,
    });
    const agreementUrl = new URL(urls[1]!);
    expect(agreementUrl.searchParams.get("conditions")).toBe(
      "name like '%Managed Services%'",
    );
    expect(agreementUrl.searchParams.getAll("fields")).toEqual([
      agreementCollectionFields,
    ]);

    await expect(
      client.catalogGet("company.configurations", { pageSize: 20 }),
    ).rejects.toThrow("Missing query");
    for (const [route, key] of [
      ["company.configurations", "query"],
      ["finance.agreements.byName", "name"],
    ] as const) {
      for (const value of ["x", "%", "A_", "ok\nno"]) {
        await expect(
          client.catalogGet(route, { [key]: value, pageSize: 20 }),
        ).rejects.toThrow(/Invalid .*search text|Invalid (query|name)/);
      }
      await expect(
        client.catalogGet(route, { [key]: "valid", pageSize: 21 }),
      ).rejects.toThrow("Invalid targeted search page size");
    }
    expect(urls).toHaveLength(2);
  });

  it("verifies every targeted catalog result matches the requested name", async () => {
    for (const { route, key, value, matchingNames } of [
      {
        route: "company.configurations",
        key: "query",
        value: "  O'Brien  ",
        matchingNames: ["O'Brien Laptop", "Retired O'BRIEN Desktop"],
      },
      {
        route: "company.configurations",
        key: "query",
        value: "ΟΣ",
        matchingNames: ["ΟΣΑ"],
      },
      {
        route: "company.configurations",
        key: "query",
        value: "éx",
        matchingNames: ["E\u0301x Plan"],
      },
      {
        route: "finance.agreements.byName",
        key: "name",
        value: "Managed Services",
        matchingNames: ["Premium MANAGED SERVICES Agreement"],
      },
    ] as const) {
      const matchingRecords = matchingNames.map((name, index) => ({
        id: index + 1,
        name,
      }));
      const matchingClient = createConnectWiseClient(credentials, {
        fetcher: async () => Response.json(matchingRecords),
      });
      await expect(
        matchingClient.catalogGet(route, { [key]: value, pageSize: 20 }),
      ).resolves.toEqual(matchingRecords);

      const laterMismatchClient = createConnectWiseClient(credentials, {
        fetcher: async () =>
          Response.json([...matchingRecords, { id: 99, name: "Unrelated" }]),
      });
      await expect(
        laterMismatchClient.catalogGet(route, { [key]: value, pageSize: 20 }),
      ).rejects.toThrow(
        "ConnectWise record does not match targeted name search",
      );

      for (const name of [undefined, null, 7, {}, []]) {
        const malformedClient = createConnectWiseClient(credentials, {
          fetcher: async () => Response.json([{ id: 1, name }]),
        });
        await expect(
          malformedClient.catalogGet(route, { [key]: value, pageSize: 20 }),
        ).rejects.toThrow(
          "ConnectWise record does not match targeted name search",
        );
      }
    }
  });

  it("binds member-scoped catalog routes to the mapped profile", async () => {
    const urls: string[] = [];
    const client = createConnectWiseClient(credentials, {
      fetcher: async (input) => {
        urls.push(String(input));
        return Response.json([]);
      },
    });

    for (const route of [
      "service.tickets.byOwner",
      "time.entries.byMember",
      "schedule.entries.byMember",
    ] as const) {
      await client.catalogGet(route, { pageSize: 20 });
    }

    expect(new URL(urls[0]!).searchParams.get("conditions")).toBe(
      "owner/id=149 and closedFlag=false",
    );
    expect(new URL(urls[0]!).searchParams.get("fields")).toBe(
      serviceTicketReadFields,
    );
    expect(new URL(urls[0]!).searchParams.get("orderBy")).toBe(
      "dateEntered desc",
    );
    expect(new URL(urls[1]!).searchParams.get("conditions")).toBe(
      "member/id=149",
    );
    expect(new URL(urls[1]!).searchParams.getAll("fields")).toEqual([
      timeEntryReadFields,
    ]);
    expect(new URL(urls[2]!).searchParams.get("conditions")).toBe(
      "member/id=149",
    );
    expect(new URL(urls[2]!).searchParams.getAll("fields")).toEqual([
      scheduleEntryCollectionFields,
    ]);
  });

  it("rejects catalog member overrides and missing profile member IDs", async () => {
    let requests = 0;
    const fetcher = async () => {
      requests += 1;
      return Response.json([]);
    };
    const memberScopedRoutes = [
      "service.tickets.byOwner",
      "time.entries.byMember",
      "schedule.entries.byMember",
    ] as const;
    const client = createConnectWiseClient(credentials, { fetcher });

    for (const route of memberScopedRoutes) {
      await expect(
        client.catalogGet(route, { memberId: 999, pageSize: 20 }),
      ).rejects.toThrow("Catalog memberId must match the mapped profile");
    }

    const credentialsWithoutMember = { ...credentials };
    delete credentialsWithoutMember.memberId;
    const clientWithoutMember = createConnectWiseClient(
      credentialsWithoutMember,
      {
        fetcher,
      },
    );
    for (const route of memberScopedRoutes) {
      await expect(
        clientWithoutMember.catalogGet(route, { pageSize: 20 }),
      ).rejects.toThrow(
        `ConnectWise profile is missing memberId; add it to enable ${route}`,
      );
    }
    expect(requests).toBe(0);
  });

  it("bounds schedule.entries.byMember with an optional date range", async () => {
    const urls: string[] = [];
    const client = createConnectWiseClient(credentials, {
      fetcher: async (input) => {
        urls.push(String(input));
        return Response.json([]);
      },
    });

    await client.catalogGet("schedule.entries.byMember", {
      memberId: 149,
      startDate: "2026-08-01",
      endDate: "2026-08-15",
      pageSize: 20,
    });
    expect(new URL(urls[0]!).searchParams.get("conditions")).toBe(
      "member/id=149 and dateStart >= [2026-08-01] and dateStart <= [2026-08-15T23:59:59]",
    );

    await expect(
      client.catalogGet("schedule.entries.byMember", {
        memberId: 149,
        startDate: "2026-08-01",
        pageSize: 20,
      }),
    ).rejects.toThrow("startDate and endDate must be provided together");

    await expect(
      client.catalogGet("schedule.entries.byMember", {
        memberId: 149,
        startDate: "2026-08-15",
        endDate: "2026-08-01",
      }),
    ).rejects.toThrow("endDate must be on or after startDate");

    await client.catalogGet("schedule.entries.byMember", {
      memberId: 149,
      startDate: "2026-08-01",
      endDate: "2026-08-31",
    });
    expect(new URL(urls[1]!).searchParams.get("conditions")).toBe(
      "member/id=149 and dateStart >= [2026-08-01] and dateStart <= [2026-08-31T23:59:59]",
    );

    await expect(
      client.catalogGet("schedule.entries.byMember", {
        memberId: 149,
        startDate: "2026-08-01",
        endDate: "2026-09-01",
      }),
    ).rejects.toThrow("Date range must be 31 days or less");

    await expect(
      client.catalogGet("schedule.entries.byMember", {
        memberId: 149,
        startDate: "2026-08-01",
        endDate: "2026-09-30",
      }),
    ).rejects.toThrow("Date range must be 31 days or less");

    await expect(
      client.catalogGet("schedule.entries.byMember", {
        memberId: 149,
        startDate: "08/01/2026",
        endDate: "2026-08-15",
      }),
    ).rejects.toThrow("Invalid startDate");

    await expect(
      client.catalogGet("schedule.entries.byMember", {
        memberId: 149,
        startDate: "2026-02-30",
        endDate: "2026-03-01",
      }),
    ).rejects.toThrow("Invalid startDate calendar date");
  });

  it("verifies returned schedule entries stay within the requested date range", async () => {
    const responses: unknown[][] = [
      [
        { id: 2, member: { id: 149 }, dateStart: "2026-08-15T23:59:59Z" },
        { id: 1, member: { id: 149 }, dateStart: "2026-08-01T00:00:00Z" },
      ],
      [{ id: 3, member: { id: 149 }, dateStart: "2026-07-31T23:59:59Z" }],
      [{ id: 4, member: { id: 149 }, dateStart: "2026-08-16T00:00:00Z" }],
      [{ id: 5, member: { id: 149 } }],
      [{ id: 6, member: { id: 149 }, dateStart: "2026-02-30T12:00:00Z" }],
      [{ id: 7, member: { id: 149 }, dateStart: "2026-08-01Tgarbage" }],
      [{ id: 8, member: { id: 149 }, dateStart: "2026-08-01T00:00:00+01:00" }],
      [{ id: 9, member: { id: 149 }, dateStart: "2026-08-15T23:59:59-01:00" }],
      [{ id: 10, member: { id: 149 }, dateStart: "not-a-date" }],
    ];
    let responseIndex = 0;
    const client = createConnectWiseClient(credentials, {
      fetcher: async () => Response.json(responses[responseIndex++]!),
    });
    const range = {
      memberId: 149,
      startDate: "2026-08-01",
      endDate: "2026-08-15",
    };

    await expect(
      client.catalogGet("schedule.entries.byMember", range),
    ).resolves.toEqual([
      { id: 1, member: { id: 149 }, dateStart: "2026-08-01T00:00:00Z" },
      { id: 2, member: { id: 149 }, dateStart: "2026-08-15T23:59:59Z" },
    ]);
    for (let index = 0; index < 7; index += 1) {
      await expect(
        client.catalogGet("schedule.entries.byMember", range),
      ).rejects.toThrow(
        "ConnectWise schedule entry is outside requested date range",
      );
    }
    await expect(
      client.catalogGet("schedule.entries.byMember", { memberId: 149 }),
    ).rejects.toThrow("ConnectWise schedule entry has invalid dateStart");
  });

  it.each([
    ["missing", { id: 1, member: { id: 149 } }],
    ["non-string", { id: 1, member: { id: 149 }, dateStart: 123 }],
    [
      "invalid calendar date",
      {
        id: 1,
        member: { id: 149 },
        dateStart: "2026-02-30T12:00:00Z",
      },
    ],
    [
      "offsetless",
      { id: 1, member: { id: 149 }, dateStart: "2026-08-01T12:00:00" },
    ],
    [
      "mixed with a valid entry",
      [
        {
          id: 1,
          member: { id: 149 },
          dateStart: "2026-08-01T12:00:00Z",
        },
        { id: 2, member: { id: 149 }, dateStart: "garbage" },
      ],
    ],
  ])("rejects %s schedule dateStart values", async (_label, response) => {
    const client = createConnectWiseClient(credentials, {
      fetcher: async () =>
        Response.json(Array.isArray(response) ? response : [response]),
    });

    await expect(
      client.catalogGet("schedule.entries.byMember", { memberId: 149 }),
    ).rejects.toThrow("ConnectWise schedule entry has invalid dateStart");
  });

  it("orders schedule entries by chronological instant across offsets", async () => {
    const client = createConnectWiseClient(credentials, {
      fetcher: async () =>
        Response.json([
          {
            id: 1,
            member: { id: 149 },
            dateStart: "2026-08-01T10:00:00-05:00",
          },
          {
            id: 2,
            member: { id: 149 },
            dateStart: "2026-08-01T11:00:00+05:00",
          },
        ]),
    });

    await expect(
      client.catalogGet("schedule.entries.byMember", { memberId: 149 }),
    ).resolves.toEqual([
      {
        id: 2,
        member: { id: 149 },
        dateStart: "2026-08-01T11:00:00+05:00",
      },
      {
        id: 1,
        member: { id: 149 },
        dateStart: "2026-08-01T10:00:00-05:00",
      },
    ]);
  });

  it("scopes dedicated schedule reads to the mapped profile member", async () => {
    const urls: string[] = [];
    const client = createConnectWiseClient(credentials, {
      fetcher: async (input) => {
        urls.push(String(input));
        return Response.json([
          { id: 2, member: { id: 149 }, privateField: "not projected here" },
        ]);
      },
    });

    await expect(client.listScheduleEntries(7)).resolves.toEqual([
      { id: 2, member: { id: 149 }, privateField: "not projected here" },
    ]);
    const url = new URL(urls[0]!);
    expect(url.searchParams.get("conditions")).toBe("member/id=149");
    expect(url.searchParams.getAll("fields")).toEqual([
      scheduleEntryCollectionFields,
    ]);
    expect(url.searchParams.get("pageSize")).toBe("7");
    expect(url.searchParams.has("orderBy")).toBe(false);
  });

  it("rejects schedule reads without a mapped member before fetching", async () => {
    let requests = 0;
    const client = createConnectWiseClient(
      { ...credentials, memberId: undefined },
      {
        fetcher: async () => {
          requests += 1;
          return Response.json([]);
        },
      },
    );

    await expect(client.listScheduleEntries(20)).rejects.toThrow(
      "ConnectWise profile is missing memberId; add it to enable list_schedule_entries",
    );
    expect(requests).toBe(0);
  });

  it("scopes timesheet reads to the mapped profile member", async () => {
    const urls: string[] = [];
    const client = createConnectWiseClient(credentials, {
      fetcher: async (input) => {
        urls.push(String(input));
        return Response.json([{ id: 21, member: { id: 149 } }]);
      },
    });

    await expect(client.getTimeSheets(9)).resolves.toEqual([
      { id: 21, member: { id: 149 } },
    ]);
    const url = new URL(urls[0]!);
    expect(url.searchParams.get("conditions")).toBe("member/id=149");
    expect(url.searchParams.getAll("fields")).toEqual([
      timeSheetCollectionFields,
    ]);
    expect(url.searchParams.get("orderBy")).toBe("dateStart desc");
    expect(url.searchParams.get("pageSize")).toBe("9");
  });

  it("rejects timesheet reads without a mapped member before fetching", async () => {
    let requests = 0;
    const client = createConnectWiseClient(
      { ...credentials, memberId: undefined },
      {
        fetcher: async () => {
          requests += 1;
          return Response.json([]);
        },
      },
    );

    await expect(client.getTimeSheets(20)).rejects.toThrow(
      "ConnectWise profile is missing memberId; add it to enable get_time_sheets",
    );
    expect(requests).toBe(0);
  });

  it("sends no orderBy on schedule entries and sorts them in the worker", async () => {
    const urls: string[] = [];
    const client = createConnectWiseClient(credentials, {
      fetcher: async (input) => {
        urls.push(String(input));
        return Response.json([
          {
            id: 2,
            member: { id: 149 },
            dateStart: "2026-09-02T13:30:00Z",
          },
          {
            id: 1,
            member: { id: 149 },
            dateStart: "2026-08-31T18:15:00Z",
          },
          {
            id: 3,
            member: { id: 149 },
            dateStart: "2026-09-01T12:30:00Z",
          },
        ]);
      },
    });

    const result = await client.catalogGet("schedule.entries.byMember", {
      memberId: 149,
      startDate: "2026-08-31",
      endDate: "2026-09-06",
    });
    expect(new URL(urls[0]!).searchParams.has("orderBy")).toBe(false);
    expect(result).toEqual([
      {
        id: 1,
        member: { id: 149 },
        dateStart: "2026-08-31T18:15:00Z",
      },
      {
        id: 3,
        member: { id: 149 },
        dateStart: "2026-09-01T12:30:00Z",
      },
      {
        id: 2,
        member: { id: 149 },
        dateStart: "2026-09-02T13:30:00Z",
      },
    ]);
  });

  it("rejects oversized catalog responses before schedule sorting", async () => {
    const urls: string[] = [];
    const oversizedResponses = [
      Array.from({ length: 21 }, (_, index) => ({
        id: index + 1,
        dateStart: "2026-09-01T12:00:00Z",
      })),
      Array.from({ length: 51 }, (_, index) => ({
        id: index + 1,
        dateStart: "2026-09-01T12:00:00Z",
      })),
    ];
    const client = createConnectWiseClient(credentials, {
      fetcher: async (input) => {
        urls.push(String(input));
        return Response.json(oversizedResponses[urls.length - 1]);
      },
    });

    await expect(
      client.catalogGet("schedule.entries.byMember", {
        memberId: 149,
        startDate: "2026-08-31",
        endDate: "2026-09-06",
      }),
    ).rejects.toThrow("ConnectWise response exceeded requested page size");
    await expect(
      client.catalogGet("schedule.entries.byMember", {
        memberId: 149,
        startDate: "2026-08-31",
        endDate: "2026-09-06",
        pageSize: 50,
      }),
    ).rejects.toThrow("ConnectWise response exceeded requested page size");
    expect(
      urls.map((url) => new URL(url).searchParams.get("pageSize")),
    ).toEqual(["20", "50"]);
  });

  it("filters byOwner on owner with open-only default and explicit fields", async () => {
    const urls: string[] = [];
    const client = createConnectWiseClient(credentials, {
      fetcher: async (input) => {
        urls.push(String(input));
        return Response.json([]);
      },
    });

    await client.catalogGet("service.tickets.byOwner", { memberId: 149 });
    const first = new URL(urls[0]!);
    expect(first.searchParams.get("conditions")).toBe(
      "owner/id=149 and closedFlag=false",
    );
    expect(first.searchParams.get("fields")?.split(",")).toEqual(
      expect.arrayContaining([
        "status",
        "board",
        "priority",
        "owner",
        "closedFlag",
        "closedDate",
        "dateResolved",
      ]),
    );
    expect(first.searchParams.get("orderBy")).toBe("dateEntered desc");

    await client.catalogGet("service.tickets.byOwner", {
      memberId: 149,
      includeClosed: "true",
    });
    expect(new URL(urls[1]!).searchParams.get("conditions")).toBe(
      "owner/id=149",
    );

    await expect(
      client.catalogGet("service.tickets.byOwner", {
        memberId: 149,
        includeClosed: "yes",
      }),
    ).rejects.toThrow("includeClosed must be 'true' or 'false'");
  });

  it("fails closed when open-only byOwner reads return non-open tickets", async () => {
    for (const includeClosed of [undefined, "false"] as const) {
      for (const closedFlag of [true, undefined, null, "false"]) {
        const client = createConnectWiseClient(credentials, {
          fetcher: async () =>
            Response.json([
              {
                id: 912,
                owner: { id: 149 },
                ...(closedFlag === undefined ? {} : { closedFlag }),
              },
            ]),
        });

        await expect(
          client.catalogGet("service.tickets.byOwner", {
            memberId: 149,
            ...(includeClosed === undefined ? {} : { includeClosed }),
          }),
        ).rejects.toThrow("ConnectWise returned a non-open ticket");
      }
    }
  });

  it("verifies recent-first ticket catalog windows from upstream", async () => {
    const ticket = (dateEntered: unknown) => ({
      id: 912,
      owner: { id: 149 },
      status: { id: 547 },
      closedFlag: false,
      _info: { dateEntered },
    });
    const routes = [
      ["service.tickets.byOwner", { pageSize: 20 }],
      ["service.tickets.byStatus", { statusId: 547, pageSize: 20 }],
    ] as const;

    for (const [route, params] of routes) {
      const ordered = [
        ticket("2026-10-16T09:00:00-04:00"),
        ticket("2026-10-16T12:00:00Z"),
        ticket("2026-10-16T12:00:00+00:00"),
        ticket("2026-10-15T12:00:00Z"),
      ];
      const orderedClient = createConnectWiseClient(credentials, {
        fetcher: async () => Response.json(ordered),
      });
      await expect(orderedClient.catalogGet(route, params)).resolves.toEqual(
        ordered,
      );

      const ascendingClient = createConnectWiseClient(credentials, {
        fetcher: async () =>
          Response.json([
            ticket("2026-10-15T12:00:00Z"),
            ticket("2026-10-16T12:00:00Z"),
          ]),
      });
      await expect(ascendingClient.catalogGet(route, params)).rejects.toThrow(
        "ConnectWise tickets are not ordered recent-first",
      );

      for (const dateEntered of [
        undefined,
        null,
        42,
        "0",
        "2026-10-16",
        "2026-10-16T12:00:00",
        "Fri, 16 Oct 2026 12:00:00 GMT",
        "2026-02-30T12:00:00Z",
        "2026-10-16T12:00:00.0000001Z",
        "2026-10-16T24:00:00Z",
        "2026-10-16T12:60:00Z",
        "2026-10-16T12:00:00+14:01",
      ]) {
        const malformedClient = createConnectWiseClient(credentials, {
          fetcher: async () => Response.json([ticket(dateEntered)]),
        });
        await expect(malformedClient.catalogGet(route, params)).rejects.toThrow(
          "ConnectWise tickets are not ordered recent-first",
        );
      }
    }
  });

  it("verifies recent-first dedicated ticket windows from upstream", async () => {
    const ticket = (dateEntered: unknown) => ({
      id: 912,
      board: { id: 32 },
      summary: "Printer outage",
      _info: { dateEntered },
    });
    const reads = [
      (client: ReturnType<typeof createConnectWiseClient>) =>
        client.listBoardTickets(32, 20),
      (client: ReturnType<typeof createConnectWiseClient>) =>
        client.searchServiceTickets("printer", 20),
    ];

    for (const read of reads) {
      const auditOutcome = (logs: string[], outcome: string) => {
        expect(logs).toHaveLength(1);
        expect(JSON.parse(logs[0]!)).toEqual(
          expect.objectContaining({
            event: "cw_request",
            method: "GET",
            status: 200,
            outcome,
          }),
        );
      };
      const ordered = [
        ticket("2026-10-16T09:00:00-04:00"),
        ticket("2026-10-16T12:00:00Z"),
        ticket("2026-10-15T12:00:00Z"),
      ];
      const orderedLogs: string[] = [];
      const orderedClient = createConnectWiseClient(credentials, {
        fetcher: async () => Response.json(ordered),
        log: (line) => orderedLogs.push(line),
      });
      await expect(read(orderedClient)).resolves.toEqual(ordered);
      auditOutcome(orderedLogs, "success");

      const ascendingLogs: string[] = [];
      const ascendingClient = createConnectWiseClient(credentials, {
        fetcher: async () =>
          Response.json([
            ticket("2026-10-15T12:00:00Z"),
            ticket("2026-10-16T12:00:00Z"),
          ]),
        log: (line) => ascendingLogs.push(line),
      });
      await expect(read(ascendingClient)).rejects.toThrow(
        "ConnectWise tickets are not ordered recent-first",
      );
      auditOutcome(ascendingLogs, "upstream_error");

      const malformedLogs: string[] = [];
      const malformedClient = createConnectWiseClient(credentials, {
        fetcher: async () => Response.json([ticket(undefined)]),
        log: (line) => malformedLogs.push(line),
      });
      await expect(read(malformedClient)).rejects.toThrow(
        "ConnectWise tickets are not ordered recent-first",
      );
      auditOutcome(malformedLogs, "upstream_error");
    }
  });

  it("allows closed tickets only when byOwner explicitly includes them", async () => {
    const closedTicket = {
      id: 912,
      owner: { id: 149 },
      closedFlag: true,
      _info: { dateEntered: "2026-10-16T12:00:00Z" },
    };
    const client = createConnectWiseClient(credentials, {
      fetcher: async () => Response.json([closedTicket]),
    });

    await expect(
      client.catalogGet("service.tickets.byOwner", {
        memberId: 149,
        includeClosed: "true",
      }),
    ).resolves.toEqual([closedTicket]);
  });

  it("fails closed when member-scoped reads return missing or mismatched ownership", async () => {
    const exerciseMemberScopedReads = async (
      client: ReturnType<typeof createConnectWiseClient>,
    ) => {
      const reads = [
        () => client.listTimeEntries(20),
        () => client.listScheduleEntries(20),
        () => client.getTimeSheets(20),
        () => client.catalogGet("service.tickets.byOwner", { pageSize: 20 }),
        () => client.catalogGet("time.entries.byMember", { pageSize: 20 }),
        () => client.catalogGet("schedule.entries.byMember", { pageSize: 20 }),
      ];
      for (const read of reads) {
        await expect(read()).rejects.toThrow(
          "ConnectWise record is not assigned to mapped member",
        );
      }
    };

    for (const returnedMemberId of [undefined, 150]) {
      const client = createConnectWiseClient(credentials, {
        fetcher: async (input) => {
          const conditions = new URL(String(input)).searchParams.get(
            "conditions",
          );
          const referenceField = conditions?.startsWith("owner/")
            ? "owner"
            : "member";
          return Response.json([
            {
              id: 1,
              ...(returnedMemberId === undefined
                ? {}
                : { [referenceField]: { id: returnedMemberId } }),
            },
          ]);
        },
      });
      await exerciseMemberScopedReads(client);
    }
  });

  it("audits dedicated member response validation before reporting request success", async () => {
    const reads = [
      (client: ReturnType<typeof createConnectWiseClient>) =>
        client.listTimeEntries(20),
      (client: ReturnType<typeof createConnectWiseClient>) =>
        client.listScheduleEntries(20),
      (client: ReturnType<typeof createConnectWiseClient>) =>
        client.getTimeSheets(20),
    ];

    for (const returnedMemberId of [undefined, 150]) {
      for (const read of reads) {
        let requestCount = 0;
        const logs: string[] = [];
        const client = createConnectWiseClient(credentials, {
          fetcher: async () => {
            requestCount += 1;
            return Response.json([
              {
                id: 1,
                ...(returnedMemberId === undefined
                  ? {}
                  : { member: { id: returnedMemberId } }),
              },
            ]);
          },
          log: (line) => logs.push(line),
        });

        await expect(read(client)).rejects.toThrow(
          "ConnectWise record is not assigned to mapped member",
        );
        expect(requestCount).toBe(1);
        expect(logs).toHaveLength(1);
        expect(JSON.parse(logs[0]!)).toEqual(
          expect.objectContaining({
            event: "cw_request",
            method: "GET",
            status: 200,
            outcome: "upstream_error",
          }),
        );
      }
    }

    for (const read of reads) {
      const validRecord = { id: 1, member: { id: 149 } };
      const logs: string[] = [];
      const client = createConnectWiseClient(credentials, {
        fetcher: async () => Response.json([validRecord]),
        log: (line) => logs.push(line),
      });

      await expect(read(client)).resolves.toEqual([validRecord]);
      expect(logs).toHaveLength(1);
      expect(JSON.parse(logs[0]!)).toEqual(
        expect.objectContaining({
          event: "cw_request",
          method: "GET",
          status: 200,
          outcome: "success",
        }),
      );
    }
  });

  it("audits catalog response validation before reporting request success", async () => {
    const cases = [
      {
        route: "service.tickets.byOwner",
        params: { pageSize: 20 },
        response: [
          {
            id: 1,
            owner: { id: 150 },
            closedFlag: false,
            _info: { dateEntered: "2026-10-16T12:00:00Z" },
          },
        ],
        error: "ConnectWise record is not assigned to mapped member",
      },
      {
        route: "service.tickets.byStatus",
        params: { statusId: 547, pageSize: 20 },
        response: [
          {
            id: 2,
            status: { id: 548 },
            _info: { dateEntered: "2026-10-16T12:00:00Z" },
          },
        ],
        error: "ConnectWise record does not match requested status",
      },
      {
        route: "company.configurations",
        params: { query: "router", pageSize: 20 },
        response: [{ id: 3, name: "Unrelated server" }],
        error: "ConnectWise record does not match targeted name search",
      },
    ] as const;

    for (const testCase of cases) {
      const logs: string[] = [];
      const client = createConnectWiseClient(credentials, {
        fetcher: async () => Response.json(testCase.response),
        log: (line) => logs.push(line),
      });

      await expect(
        client.catalogGet(testCase.route, testCase.params),
      ).rejects.toThrow(testCase.error);
      expect(logs).toHaveLength(1);
      expect(JSON.parse(logs[0]!)).toEqual(
        expect.objectContaining({
          event: "cw_request",
          method: "GET",
          status: 200,
          outcome: "upstream_error",
        }),
      );
    }

    const successLogs: string[] = [];
    const validTicket = {
      id: 4,
      owner: { id: 149 },
      closedFlag: false,
      _info: { dateEntered: "2026-10-16T12:00:00Z" },
    };
    const validClient = createConnectWiseClient(credentials, {
      fetcher: async () => Response.json([validTicket]),
      log: (line) => successLogs.push(line),
    });

    await expect(
      validClient.catalogGet("service.tickets.byOwner", { pageSize: 20 }),
    ).resolves.toEqual([validTicket]);
    expect(successLogs).toHaveLength(1);
    expect(JSON.parse(successLogs[0]!)).toEqual(
      expect.objectContaining({
        event: "cw_request",
        method: "GET",
        status: 200,
        outcome: "success",
      }),
    );
  });

  it("verifies a created service ticket before adding its initial description", async () => {
    const calls: Array<{ method: string; url: string }> = [];
    const client = createConnectWiseClient(credentials, {
      fetcher: async (input, init) => {
        calls.push({
          method: (init as { method?: string } | undefined)?.method ?? "GET",
          url: String(input),
        });
        if (String(input).endsWith("/service/tickets")) {
          return Response.json({
            id: 7001,
            summary: "Daily Server Backup Audit",
            company: { id: 250 },
            board: { id: 32 },
            status: { id: 547 },
            contact: { id: 81 },
            priority: { id: 4 },
            type: { id: 12 },
            owner: { id: 212 },
          });
        }
        return Response.json({ id: 9001 });
      },
    });

    await expect(
      client.createServiceTicket({
        companyId: 250,
        summary: " Daily Server Backup Audit ",
        contactId: 81,
        priorityId: 4,
        typeId: 12,
        ownerId: 212,
        initialDescription: "Verified description",
      }),
    ).resolves.toMatchObject({ id: 7001 });
    expect(
      calls.map(({ method, url }) => [method, new URL(url).pathname]),
    ).toEqual([
      ["POST", "/v4_6_release/apis/3.0/service/tickets"],
      ["POST", "/v4_6_release/apis/3.0/service/tickets/7001/notes"],
    ]);
  });

  for (const noteFailure of ["denied", "network", "invalid"] as const) {
    it(`reports the committed ticket ID when its initial description ${noteFailure} write fails`, async () => {
      const calls: string[] = [];
      const client = createConnectWiseClient(credentials, {
        fetcher: async (input) => {
          const url = String(input);
          calls.push(url);
          if (url.endsWith("/service/tickets")) {
            return Response.json({
              id: 7001,
              summary: "Daily Server Backup Audit",
              company: { id: 250 },
              board: { id: 32 },
              status: { id: 547 },
            });
          }
          if (noteFailure === "network") {
            throw new Error("secret transport detail");
          }
          if (noteFailure === "invalid") {
            return Response.json({});
          }
          return Response.json(
            { privateKey: "secret response detail" },
            { status: 403 },
          );
        },
      });

      const request = client.createServiceTicket({
        companyId: 250,
        summary: "Daily Server Backup Audit",
        initialDescription: "Verified description",
      });
      await expect(request).rejects.toBeInstanceOf(
        ConnectWisePartialServiceTicketCreateError,
      );
      await expect(request).rejects.toMatchObject({ ticketId: 7001 });
      expect(calls.map((url) => new URL(url).pathname)).toEqual([
        "/v4_6_release/apis/3.0/service/tickets",
        "/v4_6_release/apis/3.0/service/tickets/7001/notes",
      ]);
    });
  }

  it("reports a partial create when the initial description receipt names another ticket", async () => {
    for (const noteReceipt of [
      { id: 9001, ticketId: 7002 },
      { id: 9001, ticket: { id: 7002 } },
    ]) {
      const calls: string[] = [];
      const client = createConnectWiseClient(credentials, {
        fetcher: async (input) => {
          const url = String(input);
          calls.push(url);
          if (url.endsWith("/service/tickets")) {
            return Response.json({
              id: 7001,
              summary: "Daily Server Backup Audit",
              company: { id: 250 },
              board: { id: 32 },
              status: { id: 547 },
            });
          }
          return Response.json(noteReceipt);
        },
      });

      const request = client.createServiceTicket({
        companyId: 250,
        summary: "Daily Server Backup Audit",
        initialDescription: "Verified description",
      });
      await expect(request).rejects.toBeInstanceOf(
        ConnectWisePartialServiceTicketCreateError,
      );
      await expect(request).rejects.toMatchObject({ ticketId: 7001 });
      expect(calls.map((url) => new URL(url).pathname)).toEqual([
        "/v4_6_release/apis/3.0/service/tickets",
        "/v4_6_release/apis/3.0/service/tickets/7001/notes",
      ]);
    }
  });

  it("rejects malformed or misrouted created service tickets without adding a note", async () => {
    const invalidResponses: unknown[] = [
      null,
      [],
      {},
      { id: 0 },
      { id: Number.MAX_SAFE_INTEGER + 1 },
      {
        id: 7001,
        summary: "Wrong summary",
        company: { id: 250 },
        board: { id: 32 },
        status: { id: 547 },
        contact: { id: 81 },
        priority: { id: 4 },
        type: { id: 12 },
        owner: { id: 212 },
      },
      {
        id: 7001,
        summary: "Daily Server Backup Audit",
        company: { id: 251 },
        board: { id: 32 },
        status: { id: 547 },
        contact: { id: 81 },
        priority: { id: 4 },
        type: { id: 12 },
        owner: { id: 212 },
      },
      {
        id: 7001,
        summary: "Daily Server Backup Audit",
        company: { id: 250 },
        board: { id: 33 },
        status: { id: 547 },
        contact: { id: 81 },
        priority: { id: 4 },
        type: { id: 12 },
        owner: { id: 212 },
      },
      {
        id: 7001,
        summary: "Daily Server Backup Audit",
        company: { id: 250 },
        board: { id: 32 },
        status: { id: 548 },
        contact: { id: 81 },
        priority: { id: 4 },
        type: { id: 12 },
        owner: { id: 212 },
      },
      {
        id: 7001,
        summary: "Daily Server Backup Audit",
        company: { id: 250 },
        board: { id: 32 },
        status: { id: 547 },
        contact: { id: 82 },
        priority: { id: 4 },
        type: { id: 12 },
        owner: { id: 212 },
      },
      {
        id: 7001,
        summary: "Daily Server Backup Audit",
        company: { id: 250 },
        board: { id: 32 },
        status: { id: 547 },
        contact: { id: 81 },
        priority: { id: 5 },
        type: { id: 12 },
        owner: { id: 212 },
      },
      {
        id: 7001,
        summary: "Daily Server Backup Audit",
        company: { id: 250 },
        board: { id: 32 },
        status: { id: 547 },
        contact: { id: 81 },
        priority: { id: 4 },
        type: { id: 13 },
        owner: { id: 212 },
      },
      {
        id: 7001,
        summary: "Daily Server Backup Audit",
        company: { id: 250 },
        board: { id: 32 },
        status: { id: 547 },
        contact: { id: 81 },
        priority: { id: 4 },
        type: { id: 12 },
        owner: { id: 213 },
      },
    ];

    for (const response of invalidResponses) {
      const requests: string[] = [];
      const client = createConnectWiseClient(credentials, {
        fetcher: async (input) => {
          requests.push(String(input));
          return Response.json(response);
        },
      });
      await expect(
        client.createServiceTicket({
          companyId: 250,
          summary: "Daily Server Backup Audit",
          contactId: 81,
          priorityId: 4,
          typeId: 12,
          ownerId: 212,
          initialDescription: "must not be posted",
        }),
      ).rejects.toBeInstanceOf(ConnectWiseIndeterminateWriteError);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatch(/\/service\/tickets$/);
    }
  });

  it("creates a schedule entry with UTC conversion and an explicit conflict flag", async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const client = createConnectWiseClient(credentials, {
      fetcher: async (input, init) => {
        calls.push({
          method: (init as { method?: string } | undefined)?.method ?? "GET",
          url: String(input),
          ...((init as { body?: string } | undefined)?.body
            ? { body: JSON.parse((init as { body: string }).body) }
            : {}),
        });
        return Response.json({
          id: 777,
          member: { id: 149 },
          dateStart: "2026-08-31T16:30:00Z",
          dateEnd: "2026-08-31T21:00:00Z",
        });
      },
    });

    await client.createScheduleEntry({
      objectId: 1892065,
      objectType: 4,
      dateStart: "2026-08-31T12:30:00-04:00",
      dateEnd: "2026-08-31T17:00:00-04:00",
      allowConflicts: true,
      name: "Test from pi",
    });
    expect(calls[0]!.method).toBe("POST");
    expect(new URL(calls[0]!.url).pathname).toBe(
      "/v4_6_release/apis/3.0/schedule/entries",
    );
    const body = calls[0]!.body as Record<string, unknown>;
    // CW rejects fractional seconds; the client must send second precision.
    expect(body.dateStart).toBe("2026-08-31T16:30:00Z");
    expect(body.dateEnd).toBe("2026-08-31T21:00:00Z");
    expect(body.allowScheduleConflictsFlag).toBe(true);
    expect((body.member as { id: number }).id).toBe(149);

    await expect(
      client.createScheduleEntry({
        dateStart: "2026-08-31T12:30:00",
        dateEnd: "2026-08-31T17:00:00",
      }),
    ).rejects.toThrow(/explicit timezone offset/);

    await expect(
      client.createScheduleEntry({
        dateStart: "2026-08-31T12:30:00-04:00",
        dateEnd: "2026-08-31T17:00:00-04:00",
      }),
    ).rejects.toThrow(/objectId is required/);
  });

  it.each([
    [
      "zero-length",
      "2026-08-31T12:30:00-04:00",
      "2026-08-31T16:30:00Z",
      /schedule end must be after start/,
    ],
    [
      "reversed",
      "2026-08-31T17:00:00-04:00",
      "2026-08-31T12:30:00-04:00",
      /schedule end must be after start/,
    ],
    [
      "longer than 24 hours",
      "2026-08-31T12:30:00-04:00",
      "2026-09-01T16:30:01-04:00",
      /schedule duration must not exceed 24 hours/,
    ],
  ])(
    "rejects a %s schedule interval before a write",
    async (_case, dateStart, dateEnd, message) => {
      let requests = 0;
      const client = createConnectWiseClient(credentials, {
        fetcher: async () => {
          requests += 1;
          return Response.json({});
        },
      });

      await expect(
        client.createScheduleEntry({ objectId: 9, dateStart, dateEnd }),
      ).rejects.toThrow(message);
      expect(requests).toBe(0);
    },
  );

  it("rejects malformed or foreign created schedule entries", async () => {
    const invalidResponses: unknown[] = [
      null,
      [],
      {},
      { id: 0, member: { id: 149 } },
      { id: Number.MAX_SAFE_INTEGER + 1, member: { id: 149 } },
      { id: 777 },
      { id: 777, member: { id: "149" } },
      { id: 777, member: { id: 150 } },
      { id: 777, member: { id: 149 }, objectId: 42 },
      {
        id: 777,
        member: { id: 149 },
        dateStart: "2026-08-31T16:30:01Z",
      },
      {
        id: 777,
        member: { id: 149 },
        dateEnd: "2026-08-31T21:00:01Z",
      },
      { id: 777, member: { id: 149 }, type: { id: 5 } },
      { id: 777, member: { id: 149 }, status: { id: 2 } },
    ];

    for (const response of invalidResponses) {
      let requests = 0;
      const client = createConnectWiseClient(credentials, {
        fetcher: async () => {
          requests += 1;
          return Response.json(response);
        },
      });
      await expect(
        client.createScheduleEntry({
          objectId: 1892065,
          dateStart: "2026-08-31T12:30:00-04:00",
          dateEnd: "2026-08-31T17:00:00-04:00",
        }),
      ).rejects.toBeInstanceOf(ConnectWiseIndeterminateWriteError);
      expect(requests).toBe(1);
    }
  });

  it.each([
    ["schedule", "create_schedule_entry"],
    ["time", "create_time_entry"],
  ] as const)(
    "refuses %s writes without a profile member ID",
    async (kind, operation) => {
      let requests = 0;
      const credentialsWithoutMember = { ...credentials };
      delete credentialsWithoutMember.memberId;
      const client = createConnectWiseClient(credentialsWithoutMember, {
        fetcher: async () => {
          requests += 1;
          return Response.json({});
        },
      });

      const write =
        kind === "schedule"
          ? client.createScheduleEntry({
              objectId: 1,
              dateStart: "2026-08-31T12:30:00-04:00",
              dateEnd: "2026-08-31T17:00:00-04:00",
            })
          : client.createTimeEntry({
              timeStart: "2026-08-31T12:30:00-04:00",
              timeEnd: "2026-08-31T17:00:00-04:00",
            });

      await expect(write).rejects.toThrow(
        `ConnectWise profile is missing memberId; add it to enable ${operation}`,
      );
      expect(requests).toBe(0);
    },
  );

  it("logs only allowlisted request metadata", async () => {
    const logs: string[] = [];
    const client = createConnectWiseClient(credentials, {
      fetcher: async () => Response.json({ id: 777, member: { id: 149 } }),
      log: (message) => logs.push(message),
    });
    await client.createScheduleEntry({
      objectId: 1892065,
      objectType: 4,
      dateStart: "2026-08-31T08:30:00-04:00",
      dateEnd: "2026-08-31T17:00:00-04:00",
      name: "Sync test",
    });
    const logLine = logs.find((l) => l.includes("cw_request"))!;
    const requestLog = JSON.parse(logLine) as Record<string, unknown>;
    expect(Object.keys(requestLog).sort()).toEqual([
      "event",
      "latencyMs",
      "method",
      "outcome",
      "status",
    ]);
    expect(requestLog).toMatchObject({
      event: "cw_request",
      method: "POST",
      outcome: "success",
      status: 200,
    });
    expect(logLine).not.toContain("Sync test");
    expect(logLine).not.toContain("1892065");
    expect(logLine).not.toContain("api-na.myconnectwise.net");
  });

  it.each([
    [
      "service ticket update",
      "service ticket",
      (client: ReturnType<typeof createConnectWiseClient>) =>
        client.updateServiceTicket(9, { summary: "Updated" }),
    ],
    [
      "schedule entry update",
      "schedule entry",
      (client: ReturnType<typeof createConnectWiseClient>) =>
        client.updateScheduleEntry(9, { doneFlag: true }),
    ],
    [
      "schedule entry delete",
      "schedule entry",
      (client: ReturnType<typeof createConnectWiseClient>) =>
        client.deleteScheduleEntry(9),
    ],
  ] as const)(
    "rejects malformed or mismatched source identity before %s",
    async (_operation, recordType, mutate) => {
      for (const response of [
        null,
        [],
        {},
        { id: "9", member: { id: 149 } },
        { id: 10, member: { id: 149 } },
      ]) {
        const methods: string[] = [];
        const client = createConnectWiseClient(credentials, {
          fetcher: async (_input, init) => {
            methods.push(
              (init as { method?: string } | undefined)?.method ?? "GET",
            );
            return Response.json(response);
          },
        });

        await expect(mutate(client)).rejects.toThrow(
          `ConnectWise ${recordType} does not match requested ID`,
        );
        expect(methods).toEqual(["GET"]);
      }
    },
  );

  it.each([
    [
      "service ticket",
      (client: ReturnType<typeof createConnectWiseClient>) =>
        client.updateServiceTicket(9, {}),
      "at least one service ticket update field is required",
    ],
    [
      "schedule entry",
      (client: ReturnType<typeof createConnectWiseClient>) =>
        client.updateScheduleEntry(9, {}),
      "at least one schedule update field is required",
    ],
  ] as const)(
    "rejects an empty %s update without issuing a write",
    async (_recordType, update, message) => {
      const methods: string[] = [];
      const client = createConnectWiseClient(credentials, {
        fetcher: async (_input, init) => {
          methods.push(
            (init as { method?: string } | undefined)?.method ?? "GET",
          );
          return Response.json({ id: 9, member: { id: 149 } });
        },
      });

      await expect(update(client)).rejects.toThrow(message);
      expect(methods).toEqual(["GET"]);
    },
  );

  it("uses an identity-only source read and explicit service ticket patch", async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const client = createConnectWiseClient(credentials, {
      fetcher: async (input, init) => {
        const method =
          (init as { method?: string } | undefined)?.method ?? "GET";
        const rawBody = (init as { body?: string } | undefined)?.body;
        calls.push({
          method,
          url: String(input),
          ...(rawBody ? { body: JSON.parse(rawBody) } : {}),
        });
        if (method === "PATCH") {
          return Response.json({
            id: 9,
            summary: "Updated",
            owner: { id: 12 },
          });
        }
        return Response.json({
          id: 9,
          summary: "Original",
          company: { id: 1 },
          board: { id: 2 },
          status: { id: 3 },
          priority: { id: 4 },
          type: { id: 5 },
          owner: { id: 6 },
          contact: { id: 7 },
          privateKey: "must-not-be-replayed",
          unexpectedWritableField: true,
          _info: { lastUpdated: "secret" },
        });
      },
    });

    await client.updateServiceTicket(9, {
      summary: "Updated",
      ownerId: 12,
    });

    const get = calls.find((call) => call.method === "GET")!;
    expect(new URL(get.url).searchParams.get("fields")).toBe("id");
    const body = calls.find((call) => call.method === "PATCH")!.body;
    expect(body).toEqual([
      { op: "replace", path: "owner", value: { id: 12 } },
      { op: "replace", path: "summary", value: "Updated" },
    ]);
  });

  it("reconciles a misrouted service ticket update response", async () => {
    const methods: string[] = [];
    let getCount = 0;
    const client = createConnectWiseClient(credentials, {
      fetcher: async (input, init) => {
        const method =
          (init as { method?: string } | undefined)?.method ?? "GET";
        methods.push(method);
        if (method === "PATCH") {
          return Response.json({
            id: 10,
            summary: "Other ticket",
            company: { id: 123, name: "Other customer" },
          });
        }
        getCount += 1;
        if (getCount === 1) return Response.json({ id: 9 });
        expect(new URL(String(input)).searchParams.get("fields")).toBe(
          "id,summary,company,board,status,priority,type,owner,contact,closedFlag,closedDate,dateResolved,_info",
        );
        return Response.json({
          id: 9,
          summary: "Updated",
          company: { id: 1, name: "Expected customer" },
        });
      },
    });

    await expect(
      client.updateServiceTicket(9, { summary: "Updated" }),
    ).resolves.toEqual({
      id: 9,
      summary: "Updated",
      company: { id: 1, name: "Expected customer" },
    });
    expect(methods).toEqual(["GET", "PATCH", "GET"]);
  });

  it("reconciles an accepted asynchronous service ticket update response", async () => {
    const methods: string[] = [];
    let getCount = 0;
    const client = createConnectWiseClient(credentials, {
      fetcher: async (_input, init) => {
        const method =
          (init as { method?: string } | undefined)?.method ?? "GET";
        methods.push(method);
        if (method === "PATCH") {
          return Response.json({ id: 9, summary: "Updated" }, { status: 202 });
        }
        getCount += 1;
        return Response.json({
          id: 9,
          summary: getCount === 1 ? "Original" : "Still original",
        });
      },
    });

    await expect(
      client.updateServiceTicket(9, { summary: "Updated" }),
    ).rejects.toBeInstanceOf(ConnectWiseIndeterminateWriteError);
    expect(methods).toEqual(["GET", "PATCH", "GET"]);
  });

  it("rejects a service ticket update that cannot be confirmed", async () => {
    const methods: string[] = [];
    let getCount = 0;
    const client = createConnectWiseClient(credentials, {
      fetcher: async (_input, init) => {
        const method =
          (init as { method?: string } | undefined)?.method ?? "GET";
        methods.push(method);
        if (method === "PATCH") {
          return Response.json({ id: 10, summary: "Other ticket" });
        }
        getCount += 1;
        return Response.json({
          id: 9,
          summary: getCount === 1 ? "Original" : "Still original",
        });
      },
    });

    await expect(
      client.updateServiceTicket(9, { summary: "Updated" }),
    ).rejects.toBeInstanceOf(ConnectWiseIndeterminateWriteError);
    expect(methods).toEqual(["GET", "PATCH", "GET"]);
  });

  it("does not reconcile a definitive service ticket update rejection", async () => {
    const methods: string[] = [];
    const client = createConnectWiseClient(credentials, {
      fetcher: async (_input, init) => {
        const method =
          (init as { method?: string } | undefined)?.method ?? "GET";
        methods.push(method);
        return method === "PATCH"
          ? new Response(null, { status: 403 })
          : Response.json({ id: 9 });
      },
    });

    let error: unknown;
    try {
      await client.updateServiceTicket(9, { summary: "Updated" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConnectWiseRequestError);
    expect((error as ConnectWiseRequestError).status).toBe(403);
    expect(methods).toEqual(["GET", "PATCH"]);
  });

  it("reconciles an ambiguous 5xx service ticket update response", async () => {
    const methods: string[] = [];
    let getCount = 0;
    const client = createConnectWiseClient(credentials, {
      fetcher: async (_input, init) => {
        const method =
          (init as { method?: string } | undefined)?.method ?? "GET";
        methods.push(method);
        if (method === "PATCH") return new Response(null, { status: 503 });
        getCount += 1;
        return Response.json({
          id: 9,
          summary: getCount === 1 ? "Original" : "Still original",
        });
      },
    });

    await expect(
      client.updateServiceTicket(9, { summary: "Updated" }),
    ).rejects.toBeInstanceOf(ConnectWiseIndeterminateWriteError);
    expect(methods).toEqual(["GET", "PATCH", "GET"]);
  });

  it("reconciles a refused service ticket update redirect without following it", async () => {
    const calls: Array<{ method: string; url: string }> = [];
    let getCount = 0;
    const client = createConnectWiseClient(credentials, {
      fetcher: async (input, init) => {
        const method =
          (init as { method?: string } | undefined)?.method ?? "GET";
        const url = String(input);
        calls.push({ method, url });
        if (method === "PATCH") {
          return new Response(null, {
            status: 307,
            headers: { Location: "https://other.example/ticket" },
          });
        }
        getCount += 1;
        return Response.json({
          id: 9,
          summary: getCount === 1 ? "Original" : "Updated",
        });
      },
    });

    await expect(
      client.updateServiceTicket(9, { summary: "Updated" }),
    ).resolves.toMatchObject({ id: 9, summary: "Updated" });
    expect(calls.map(({ method }) => method)).toEqual(["GET", "PATCH", "GET"]);
    expect(
      calls.every(({ url }) => !url.startsWith("https://other.example")),
    ).toBe(true);
  });

  it("confirms every service ticket update field", async () => {
    const client = createConnectWiseClient(credentials, {
      fetcher: async (_input, init) => {
        const method =
          (init as { method?: string } | undefined)?.method ?? "GET";
        if (method === "GET") return Response.json({ id: 9 });
        return Response.json({
          id: 9,
          owner: { id: 11 },
          status: { id: 12 },
          board: { id: 13 },
          priority: { id: 14 },
          type: { id: 15 },
          summary: "Updated",
          contact: { id: 16 },
        });
      },
    });

    await expect(
      client.updateServiceTicket(9, {
        ownerId: 11,
        statusId: 12,
        boardId: 13,
        priorityId: 14,
        typeId: 15,
        summary: "Updated",
        contactId: 16,
      }),
    ).resolves.toMatchObject({ id: 9, summary: "Updated" });
  });

  it("reconciles an ambiguous service ticket response without a second write", async () => {
    const methods: string[] = [];
    let getCount = 0;
    const client = createConnectWiseClient(credentials, {
      fetcher: async (_input, init) => {
        const method =
          (init as { method?: string } | undefined)?.method ?? "GET";
        methods.push(method);
        if (method === "PATCH") throw new Error("response connection lost");
        getCount += 1;
        return Response.json({
          id: 9,
          summary: getCount === 1 ? "Original" : "Updated",
        });
      },
    });

    await expect(
      client.updateServiceTicket(9, { summary: "Updated" }),
    ).resolves.toMatchObject({ id: 9, summary: "Updated" });
    expect(methods).toEqual(["GET", "PATCH", "GET"]);
  });

  it("audits an empty successful PATCH response as indeterminate", async () => {
    const logs: string[] = [];
    let getCount = 0;
    const client = createConnectWiseClient(credentials, {
      fetcher: async (_input, init) => {
        const method =
          (init as { method?: string } | undefined)?.method ?? "GET";
        if (method === "PATCH") return new Response(null, { status: 200 });
        getCount += 1;
        return Response.json({
          id: 9,
          summary: getCount === 1 ? "Original" : "Updated",
        });
      },
      log: (line) => logs.push(line),
    });

    await expect(
      client.updateServiceTicket(9, { summary: "Updated" }),
    ).resolves.toMatchObject({ id: 9, summary: "Updated" });
    expect(
      logs.map((line) => {
        const event = JSON.parse(line) as Record<string, unknown>;
        return {
          event: event.event,
          method: event.method,
          status: event.status,
          outcome: event.outcome,
        };
      }),
    ).toEqual([
      { event: "cw_request", method: "GET", status: 200, outcome: "success" },
      {
        event: "cw_request",
        method: "PATCH",
        status: 200,
        outcome: "indeterminate",
      },
      { event: "cw_request", method: "GET", status: 200, outcome: "success" },
    ]);
  });

  it("updates a schedule entry via an ownership read and explicit patch", async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const client = createConnectWiseClient(credentials, {
      fetcher: async (input, init) => {
        const method =
          (init as { method?: string } | undefined)?.method ?? "GET";
        const rawBody = (init as { body?: string } | undefined)?.body;
        calls.push({
          method,
          url: String(input),
          ...(rawBody ? { body: JSON.parse(rawBody) } : {}),
        });
        if (method === "GET" && String(input).includes("/schedule/entries/9")) {
          return Response.json({
            id: 9,
            member: { id: 149 },
            dateStart: "2026-08-31T16:30:00Z",
            dateEnd: "2026-09-01T21:00:00Z",
            status: { id: 1 },
            name: "Keep me",
            doneFlag: false,
            allowScheduleConflictsFlag: true,
            privateKey: "must-not-be-replayed",
            unexpectedWritableField: true,
            _info: { lastUpdated: "secret" },
          });
        }
        return Response.json({
          id: 9,
          member: { id: 149 },
          dateStart: "2026-09-01T16:00:00Z",
          dateEnd: "2026-09-01T21:00:00Z",
          allowScheduleConflictsFlag: false,
        });
      },
    });

    await client.updateScheduleEntry(9, {
      dateStart: "2026-09-01T12:00:00-04:00",
      allowConflicts: false,
    });
    const get = calls.find((c) => c.method === "GET")!;
    expect(new URL(get.url).searchParams.get("fields")).toBe(
      "id,member,dateStart,dateEnd",
    );
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch).toBeDefined();
    expect(patch.body).toEqual([
      {
        op: "replace",
        path: "dateStart",
        value: "2026-09-01T16:00:00Z",
      },
      {
        op: "replace",
        path: "dateEnd",
        value: "2026-09-01T21:00:00Z",
      },
      {
        op: "replace",
        path: "allowScheduleConflictsFlag",
        value: false,
      },
    ]);
  });

  it.each([
    [
      "an end before the stored start",
      { dateEnd: "2026-09-01T11:00:00-04:00" },
      /schedule end must be after start/,
    ],
    [
      "a start after the stored end",
      { dateStart: "2026-09-01T15:00:00-04:00" },
      /schedule end must be after start/,
    ],
    [
      "an interval longer than 24 hours",
      { dateEnd: "2026-09-02T12:00:01-04:00" },
      /schedule duration must not exceed 24 hours/,
    ],
  ])(
    "rejects a one-sided schedule update with %s",
    async (_case, update, message) => {
      const methods: string[] = [];
      const client = createConnectWiseClient(credentials, {
        fetcher: async (_input, init) => {
          methods.push(
            (init as { method?: string } | undefined)?.method ?? "GET",
          );
          return Response.json({
            id: 9,
            member: { id: 149 },
            dateStart: "2026-09-01T16:00:00Z",
            dateEnd: "2026-09-01T18:00:00Z",
          });
        },
      });

      await expect(client.updateScheduleEntry(9, update)).rejects.toThrow(
        message,
      );
      expect(methods).toEqual(["GET"]);
    },
  );

  it.each([
    null,
    [],
    {},
    { id: "9", member: { id: 149 } },
    { id: 10, member: { id: 149 } },
    { id: 9 },
    { id: 9, member: { id: 150 } },
  ])("reconciles an invalid schedule update response %#", async (updated) => {
    const methods: string[] = [];
    let getCount = 0;
    const client = createConnectWiseClient(credentials, {
      fetcher: async (_input, init) => {
        const method =
          (init as { method?: string } | undefined)?.method ?? "GET";
        methods.push(method);
        if (method === "PATCH") return Response.json(updated);
        getCount += 1;
        return Response.json({
          id: 9,
          member: { id: 149 },
          name: getCount === 1 ? "Existing" : "Reconciled",
          doneFlag: getCount === 1 ? false : true,
        });
      },
    });

    await expect(
      client.updateScheduleEntry(9, { doneFlag: true }),
    ).resolves.toMatchObject({
      id: 9,
      member: { id: 149 },
      name: "Reconciled",
      doneFlag: true,
    });
    expect(methods).toEqual(["GET", "PATCH", "GET"]);
  });

  it("reconciles a malformed successful schedule update response", async () => {
    let getCount = 0;
    const methods: string[] = [];
    const client = createConnectWiseClient(credentials, {
      fetcher: async (_input, init) => {
        const method =
          (init as { method?: string } | undefined)?.method ?? "GET";
        methods.push(method);
        if (method === "PATCH") {
          return new Response("{", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        getCount += 1;
        return Response.json({
          id: 9,
          member: { id: 149 },
          doneFlag: getCount > 1,
        });
      },
    });

    await expect(
      client.updateScheduleEntry(9, { doneFlag: true }),
    ).resolves.toMatchObject({ id: 9, member: { id: 149 }, doneFlag: true });
    expect(methods).toEqual(["GET", "PATCH", "GET"]);
  });

  it.each([400, 403, 429])(
    "preserves an explicit schedule PATCH rejection with status %i",
    async (status) => {
      const methods: string[] = [];
      const client = createConnectWiseClient(credentials, {
        fetcher: async (_input, init) => {
          const method =
            (init as { method?: string } | undefined)?.method ?? "GET";
          methods.push(method);
          if (method === "PATCH") return new Response(null, { status });
          return Response.json({ id: 9, member: { id: 149 }, doneFlag: false });
        },
      });

      await expect(
        client.updateScheduleEntry(9, { doneFlag: true }),
      ).rejects.toMatchObject({ status });
      expect(methods).toEqual(["GET", "PATCH"]);
    },
  );

  it.each([408, 500])(
    "classifies an unconfirmed ambiguous schedule PATCH status %i as indeterminate",
    async (status) => {
      let getCount = 0;
      const methods: string[] = [];
      const client = createConnectWiseClient(credentials, {
        fetcher: async (_input, init) => {
          const method =
            (init as { method?: string } | undefined)?.method ?? "GET";
          methods.push(method);
          if (method === "PATCH") return new Response(null, { status });
          getCount += 1;
          return Response.json({
            id: 9,
            member: { id: 149 },
            doneFlag: false,
          });
        },
      });

      await expect(
        client.updateScheduleEntry(9, { doneFlag: true }),
      ).rejects.toBeInstanceOf(ConnectWiseIndeterminateWriteError);
      expect(getCount).toBe(2);
      expect(methods).toEqual(["GET", "PATCH", "GET"]);
    },
  );

  it("classifies an unconfirmed schedule PATCH redirect as indeterminate without following it", async () => {
    let getCount = 0;
    const calls: Array<{ method: string; url: string }> = [];
    const client = createConnectWiseClient(credentials, {
      fetcher: async (input, init) => {
        const method =
          (init as { method?: string } | undefined)?.method ?? "GET";
        const url = String(input);
        calls.push({ method, url });
        if (method === "PATCH") {
          return new Response(null, {
            status: 307,
            headers: { Location: "https://hostile.example/schedule" },
          });
        }
        getCount += 1;
        return Response.json({
          id: 9,
          member: { id: 149 },
          doneFlag: false,
        });
      },
    });

    await expect(
      client.updateScheduleEntry(9, { doneFlag: true }),
    ).rejects.toBeInstanceOf(ConnectWiseIndeterminateWriteError);
    expect(getCount).toBe(2);
    expect(calls.map(({ method }) => method)).toEqual(["GET", "PATCH", "GET"]);
    expect(
      calls.every(({ url }) => !url.startsWith("https://hostile.example")),
    ).toBe(true);
  });

  it("classifies an unconfirmed schedule PATCH transport failure as indeterminate", async () => {
    let getCount = 0;
    const methods: string[] = [];
    const client = createConnectWiseClient(credentials, {
      fetcher: async (_input, init) => {
        const method =
          (init as { method?: string } | undefined)?.method ?? "GET";
        methods.push(method);
        if (method === "PATCH") throw new TypeError("connection reset");
        getCount += 1;
        return Response.json({
          id: 9,
          member: { id: 149 },
          doneFlag: false,
        });
      },
    });

    await expect(
      client.updateScheduleEntry(9, { doneFlag: true }),
    ).rejects.toBeInstanceOf(ConnectWiseIndeterminateWriteError);
    expect(getCount).toBe(2);
    expect(methods).toEqual(["GET", "PATCH", "GET"]);
  });

  it("rejects an unconfirmed schedule update after reconciliation", async () => {
    let getCount = 0;
    const methods: string[] = [];
    const client = createConnectWiseClient(credentials, {
      fetcher: async (_input, init) => {
        const method =
          (init as { method?: string } | undefined)?.method ?? "GET";
        methods.push(method);
        if (method === "PATCH") return Response.json(null);
        getCount += 1;
        return Response.json({
          id: 9,
          member: { id: 149 },
          doneFlag: false,
        });
      },
    });

    await expect(
      client.updateScheduleEntry(9, { doneFlag: true }),
    ).rejects.toBeInstanceOf(ConnectWiseIndeterminateWriteError);
    expect(getCount).toBe(2);
    expect(methods).toEqual(["GET", "PATCH", "GET"]);
  });

  it("rejects an invalid schedule update response when reconciliation is invalid", async () => {
    let getCount = 0;
    const methods: string[] = [];
    const client = createConnectWiseClient(credentials, {
      fetcher: async (_input, init) => {
        const method =
          (init as { method?: string } | undefined)?.method ?? "GET";
        methods.push(method);
        if (method === "PATCH") {
          return Response.json({ id: 9, member: { id: 150 } });
        }
        getCount += 1;
        return Response.json(
          getCount === 1
            ? { id: 9, member: { id: 149 }, name: "Existing" }
            : { id: 9, member: { id: 150 }, name: "Foreign" },
        );
      },
    });

    await expect(
      client.updateScheduleEntry(9, { doneFlag: true }),
    ).rejects.toBeInstanceOf(ConnectWiseIndeterminateWriteError);
    expect(methods).toEqual(["GET", "PATCH", "GET"]);
  });

  it("refuses to update schedule entries outside the mapped member", async () => {
    const methods: string[] = [];
    const client = createConnectWiseClient(credentials, {
      fetcher: async (_input, init) => {
        methods.push(
          (init as { method?: string } | undefined)?.method ?? "GET",
        );
        return Response.json({ id: 9, member: { id: 150 } });
      },
    });

    await expect(
      client.updateScheduleEntry(9, { doneFlag: true }),
    ).rejects.toThrow("ConnectWise record is not assigned to mapped member");
    expect(methods).toEqual(["GET"]);
  });

  it("deletes only a schedule entry owned by the mapped member and confirms removal", async () => {
    const calls: string[] = [];
    let getCount = 0;
    const client = createConnectWiseClient(credentials, {
      fetcher: async (input, init) => {
        const method =
          (init as { method?: string } | undefined)?.method ?? "GET";
        calls.push(`${method} ${String(input)}`);
        if (method === "DELETE") {
          return new Response(null, { status: 204 });
        }
        getCount += 1;
        return getCount === 1
          ? Response.json({ id: 247134, member: { id: 149 } })
          : new Response(null, { status: 404 });
      },
    });
    await client.deleteScheduleEntry(247134);
    expect(calls).toEqual([
      "GET https://api-na.myconnectwise.net/v4_6_release/apis/3.0/schedule/entries/247134?fields=id%2Cmember",
      "DELETE https://api-na.myconnectwise.net/v4_6_release/apis/3.0/schedule/entries/247134",
      "GET https://api-na.myconnectwise.net/v4_6_release/apis/3.0/schedule/entries/247134?fields=id%2Cmember",
    ]);
  });

  it.each([
    ["malformed", () => new Response("{", { status: 200 })],
    [
      "oversized",
      () =>
        new Response("x", {
          status: 200,
          headers: { "Content-Length": "1000001" },
        }),
    ],
    [
      "unreadable",
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("body must not be read"));
            },
          }),
          { status: 200 },
        ),
    ],
  ])(
    "accepts a successful DELETE with a %s response body without retrying",
    async (_name, deleteResponse) => {
      const methods: string[] = [];
      let getCount = 0;
      const client = createConnectWiseClient(credentials, {
        fetcher: async (_input, init) => {
          const method =
            (init as { method?: string } | undefined)?.method ?? "GET";
          methods.push(method);
          if (method === "DELETE") return deleteResponse();
          getCount += 1;
          return getCount === 1
            ? Response.json({ id: 247134, member: { id: 149 } })
            : new Response(null, { status: 404 });
        },
      });

      await client.deleteScheduleEntry(247134);
      expect(methods).toEqual(["GET", "DELETE", "GET"]);
    },
  );

  it("cancels an unused successful DELETE response body", async () => {
    let cancelled = false;
    let getCount = 0;
    const client = createConnectWiseClient(credentials, {
      fetcher: async (_input, init) => {
        const method =
          (init as { method?: string } | undefined)?.method ?? "GET";
        if (method === "GET") {
          getCount += 1;
          return getCount === 1
            ? Response.json({ id: 247134, member: { id: 149 } })
            : new Response(null, { status: 404 });
        }
        return new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { status: 200 },
        );
      },
    });

    await client.deleteScheduleEntry(247134);
    expect(cancelled).toBe(true);
  });

  it("classifies a synchronous DELETE that leaves the entry present as indeterminate", async () => {
    const methods: string[] = [];
    const client = createConnectWiseClient(credentials, {
      fetcher: async (_input, init) => {
        const method =
          (init as { method?: string } | undefined)?.method ?? "GET";
        methods.push(method);
        return method === "DELETE"
          ? new Response(null, { status: 204 })
          : Response.json({ id: 247134, member: { id: 149 } });
      },
    });

    await expect(client.deleteScheduleEntry(247134)).rejects.toBeInstanceOf(
      ConnectWiseIndeterminateWriteError,
    );
    expect(methods).toEqual(["GET", "DELETE", "GET"]);
  });

  it.each([
    ["unavailable", () => Promise.reject(new Error("response lost"))],
    [
      "server error",
      () => Promise.resolve(new Response(null, { status: 503 })),
    ],
    [
      "redirected",
      () =>
        Promise.resolve(
          new Response(null, {
            status: 307,
            headers: { Location: "https://hostile.example/" },
          }),
        ),
    ],
    ["malformed", () => Promise.resolve(Response.json({ id: 247135 }))],
  ])(
    "classifies a %s deletion confirmation as indeterminate without repeating DELETE",
    async (_name, confirmationResult) => {
      const methods: string[] = [];
      let getCount = 0;
      const client = createConnectWiseClient(credentials, {
        fetcher: async (_input, init) => {
          const method =
            (init as { method?: string } | undefined)?.method ?? "GET";
          methods.push(method);
          if (method === "DELETE") {
            return new Response(null, { status: 204 });
          }
          getCount += 1;
          return getCount === 1
            ? Response.json({ id: 247134, member: { id: 149 } })
            : confirmationResult();
        },
      });

      await expect(client.deleteScheduleEntry(247134)).rejects.toBeInstanceOf(
        ConnectWiseIndeterminateWriteError,
      );
      expect(methods.filter((method) => method === "DELETE")).toHaveLength(1);
    },
  );

  it("classifies an accepted asynchronous DELETE as indeterminate", async () => {
    let cancelled = false;
    const logs: string[] = [];
    const methods: string[] = [];
    const client = createConnectWiseClient(credentials, {
      log: (message) => logs.push(message),
      fetcher: async (_input, init) => {
        const method =
          (init as { method?: string } | undefined)?.method ?? "GET";
        methods.push(method);
        if (method === "GET") {
          return Response.json({ id: 247134, member: { id: 149 } });
        }
        return new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { status: 202 },
        );
      },
    });

    await expect(client.deleteScheduleEntry(247134)).rejects.toBeInstanceOf(
      ConnectWiseIndeterminateWriteError,
    );
    expect(methods).toEqual(["GET", "DELETE"]);
    expect(cancelled).toBe(true);
    const requestLogs = logs
      .filter((line) => line.includes('"event":"cw_request"'))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(requestLogs).toHaveLength(2);
    expect(requestLogs[1]).toMatchObject({
      event: "cw_request",
      method: "DELETE",
      outcome: "indeterminate",
      status: 202,
    });
  });

  it.each([
    ["a lost response", () => Promise.reject(new Error("response lost"))],
    [
      "an upstream timeout",
      () => Promise.resolve(new Response(null, { status: 408 })),
    ],
    [
      "an upstream server error",
      () => Promise.resolve(new Response(null, { status: 503 })),
    ],
    [
      "an upstream redirect",
      () =>
        Promise.resolve(
          new Response(null, {
            status: 307,
            headers: { Location: "https://hostile.example/" },
          }),
        ),
    ],
  ])(
    "classifies %s after DELETE as an indeterminate write",
    async (_name, deleteResult) => {
      const methods: string[] = [];
      const client = createConnectWiseClient(credentials, {
        fetcher: async (_input, init) => {
          const method =
            (init as { method?: string } | undefined)?.method ?? "GET";
          methods.push(method);
          if (method === "GET") {
            return Response.json({ id: 247134, member: { id: 149 } });
          }
          return deleteResult();
        },
      });

      await expect(client.deleteScheduleEntry(247134)).rejects.toBeInstanceOf(
        ConnectWiseIndeterminateWriteError,
      );
      expect(methods).toEqual(["GET", "DELETE"]);
    },
  );

  it("refuses to delete schedule entries with missing or mismatched ownership", async () => {
    for (const member of [undefined, { id: 150 }]) {
      const methods: string[] = [];
      const client = createConnectWiseClient(credentials, {
        fetcher: async (_input, init) => {
          methods.push(
            (init as { method?: string } | undefined)?.method ?? "GET",
          );
          return Response.json({ id: 247134, ...(member ? { member } : {}) });
        },
      });

      await expect(client.deleteScheduleEntry(247134)).rejects.toThrow(
        "ConnectWise record is not assigned to mapped member",
      );
      expect(methods).toEqual(["GET"]);
    }
  });

  it("refuses time-entry attachment writes outside the mapped member", async () => {
    const attachmentMethods: string[] = [];
    const attachmentClient = createConnectWiseClient(credentials, {
      fetcher: async (_input, init) => {
        attachmentMethods.push(
          (init as { method?: string } | undefined)?.method ?? "GET",
        );
        return Response.json({ id: 42, member: { id: 150 } });
      },
    });
    await expect(
      attachmentClient.attachImageToTimeEntry(42, {
        filename: "image.png",
        base64: "iVBORw0KGgo=",
        mimeType: "image/png",
      }),
    ).rejects.toThrow("ConnectWise record is not assigned to mapped member");
    expect(attachmentMethods).toEqual(["GET"]);

    const uploadMethods: string[] = [];
    const uploadClient = createConnectWiseClient(credentials, {
      fetcher: async (_input, init) => {
        uploadMethods.push(
          (init as { method?: string } | undefined)?.method ?? "GET",
        );
        return Response.json({ id: 42 });
      },
    });
    await expect(
      uploadClient.uploadImageDocument("TimeEntry", 42, {
        fileName: "image.png",
        mimeType: "image/png",
        base64: "iVBORw0KGgo=",
        privateFlag: true,
      }),
    ).rejects.toThrow("ConnectWise record is not assigned to mapped member");
    expect(uploadMethods).toEqual(["GET"]);
  });

  it("rejects malformed or mismatched time-entry attachment authorization responses", async () => {
    const invalidEntries: unknown[] = [
      null,
      [],
      {},
      { id: "42", member: { id: 149 } },
      { id: 43, member: { id: 149 } },
    ];

    for (const invalidEntry of invalidEntries) {
      for (const writeForm of ["attachment", "document"] as const) {
        const methods: string[] = [];
        const client = createConnectWiseClient(credentials, {
          fetcher: async (_input, init) => {
            methods.push(
              (init as { method?: string } | undefined)?.method ?? "GET",
            );
            return Response.json(invalidEntry);
          },
        });

        const write =
          writeForm === "attachment"
            ? client.attachImageToTimeEntry(42, {
                filename: "image.png",
                base64: "iVBORw0KGgo=",
                mimeType: "image/png",
              })
            : client.uploadImageDocument("TimeEntry", 42, {
                fileName: "image.png",
                mimeType: "image/png",
                base64: "iVBORw0KGgo=",
                privateFlag: true,
              });

        await expect(write).rejects.toThrow(
          "ConnectWise time entry does not match requested ID",
        );
        expect(methods).toEqual(["GET"]);
      }
    }
  });

  it("checks time-entry ownership before both attachment write forms", async () => {
    const calls: string[] = [];
    const client = createConnectWiseClient(credentials, {
      fetcher: async (input, init) => {
        const method =
          (init as { method?: string } | undefined)?.method ?? "GET";
        calls.push(`${method} ${String(input)}`);
        if (method === "GET") {
          const url = new URL(String(input));
          if (url.pathname.endsWith("/system/documents/901")) {
            return Response.json({
              id: 901,
              recordType: "TimeEntry",
              recordId: 42,
            });
          }
          return Response.json({ id: 42, member: { id: 149 } });
        }
        return Response.json({ id: 901 }, { status: 201 });
      },
    });

    await client.attachImageToTimeEntry(42, {
      filename: "image.png",
      base64: "iVBORw0KGgo=",
      mimeType: "image/png",
    });
    await client.uploadImageDocument("TimeEntry", 42, {
      fileName: "image.png",
      mimeType: "image/png",
      base64: "iVBORw0KGgo=",
      privateFlag: true,
    });

    expect(calls.map((call) => call.split(" ")[0])).toEqual([
      "GET",
      "POST",
      "GET",
      "GET",
      "POST",
      "GET",
    ]);
    const ownershipCalls = calls.filter((call) =>
      call.includes("/time/entries/42?"),
    );
    expect(ownershipCalls).toHaveLength(2);
    for (const lookupCall of ownershipCalls) {
      const lookupUrl = new URL(lookupCall.slice("GET ".length));
      expect(lookupUrl.pathname).toBe("/v4_6_release/apis/3.0/time/entries/42");
      expect(lookupUrl.searchParams.getAll("fields")).toEqual(["id,member"]);
      expect([...lookupUrl.searchParams.keys()]).toEqual(["fields"]);
    }
    const confirmationCalls = calls.filter((call) =>
      call.includes("/system/documents/901?"),
    );
    expect(confirmationCalls).toHaveLength(2);
    for (const confirmationCall of confirmationCalls) {
      const confirmationUrl = new URL(confirmationCall.slice("GET ".length));
      expect(confirmationUrl.searchParams.getAll("fields")).toEqual([
        "id,recordType,recordId",
      ]);
      expect([...confirmationUrl.searchParams.keys()]).toEqual(["fields"]);
    }
  });

  it.each(["attachment", "document"] as const)(
    "classifies a mismatched %s creation confirmation as indeterminate without repeating the write",
    async (writeForm) => {
      const calls: string[] = [];
      const logs: string[] = [];
      const client = createConnectWiseClient(credentials, {
        fetcher: async (input, init) => {
          const method = init?.method ?? "GET";
          calls.push(`${method} ${String(input)}`);
          if (method === "POST") {
            return Response.json({ id: 901 }, { status: 201 });
          }
          return Response.json({
            id: 901,
            recordType: "Ticket",
            recordId: 78,
          });
        },
        log: (line) => logs.push(line),
      });

      const write =
        writeForm === "attachment"
          ? client.attachImageToTicket(77, {
              filename: "image.png",
              base64: "iVBORw0KGgo=",
              mimeType: "image/png",
            })
          : client.uploadImageDocument("Ticket", 77, {
              fileName: "image.png",
              mimeType: "image/png",
              base64: "iVBORw0KGgo=",
              privateFlag: true,
            });

      await expect(write).rejects.toBeInstanceOf(
        ConnectWiseIndeterminateWriteError,
      );
      expect(calls.map((call) => call.split(" ")[0])).toEqual(["POST", "GET"]);
      expect(calls[1]).toContain(
        "/system/documents/901?fields=id%2CrecordType%2CrecordId",
      );
      const requestLogs = logs.map(
        (line) => JSON.parse(line) as Record<string, unknown>,
      );
      expect(requestLogs.filter((entry) => entry.method === "POST")).toEqual([
        expect.objectContaining({ outcome: "indeterminate", status: 201 }),
      ]);
      expect(requestLogs).not.toContainEqual(
        expect.objectContaining({ method: "POST", outcome: "success" }),
      );
    },
  );

  it("classifies a mismatched time-entry attachment confirmation as indeterminate without repeating the write", async () => {
    const methods: string[] = [];
    const logs: string[] = [];
    const client = createConnectWiseClient(credentials, {
      fetcher: async (input, init) => {
        const method = init?.method ?? "GET";
        methods.push(method);
        if (method === "POST") {
          return Response.json({ id: 902 }, { status: 201 });
        }
        const url = new URL(String(input));
        if (url.pathname.endsWith("/time/entries/42")) {
          return Response.json({ id: 42, member: { id: 149 } });
        }
        return Response.json({
          id: 902,
          recordType: "Ticket",
          recordId: 42,
        });
      },
      log: (line) => logs.push(line),
    });

    await expect(
      client.attachImageToTimeEntry(42, {
        filename: "image.png",
        base64: "iVBORw0KGgo=",
        mimeType: "image/png",
      }),
    ).rejects.toBeInstanceOf(ConnectWiseIndeterminateWriteError);
    expect(methods).toEqual(["GET", "POST", "GET"]);
    const postLogs = logs
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.method === "POST");
    expect(postLogs).toEqual([
      expect.objectContaining({ outcome: "indeterminate", status: 201 }),
    ]);
  });

  it.each([
    {
      label: "wrong document ID",
      confirmation: { id: 902, recordType: "Ticket", recordId: 77 },
    },
    {
      label: "wrong record type",
      confirmation: { id: 901, recordType: "TimeEntry", recordId: 77 },
    },
    { label: "malformed body", confirmation: null },
  ])(
    "rejects a created-document confirmation with $label",
    async ({ confirmation }) => {
      const methods: string[] = [];
      const client = createConnectWiseClient(credentials, {
        fetcher: async (_input, init) => {
          const method = init?.method ?? "GET";
          methods.push(method);
          return method === "POST"
            ? Response.json({ id: 901 }, { status: 201 })
            : Response.json(confirmation);
        },
      });

      await expect(
        client.attachImageToTicket(77, {
          filename: "image.png",
          base64: "iVBORw0KGgo=",
          mimeType: "image/png",
        }),
      ).rejects.toBeInstanceOf(ConnectWiseIndeterminateWriteError);
      expect(methods).toEqual(["POST", "GET"]);
    },
  );

  it.each([
    { label: "fetch failures", getResponse: "throw" as const },
    { label: "retryable responses", getResponse: "retryable" as const },
  ])(
    "exhausts bounded confirmation retries after $label without repeating the write",
    async ({ getResponse }) => {
      const methods: string[] = [];
      const client = createConnectWiseClient(credentials, {
        fetcher: async (_input, init) => {
          const method = init?.method ?? "GET";
          methods.push(method);
          if (method === "POST") {
            return Response.json({ id: 901 }, { status: 201 });
          }
          if (getResponse === "throw") throw new Error("unavailable");
          return new Response(null, { status: 503 });
        },
        sleep: async () => {},
      });

      await expect(
        client.attachImageToTicket(77, {
          filename: "image.png",
          base64: "iVBORw0KGgo=",
          mimeType: "image/png",
        }),
      ).rejects.toBeInstanceOf(ConnectWiseIndeterminateWriteError);
      expect(methods).toEqual(["POST", "GET", "GET"]);
    },
  );

  it("accepts an exact created-document confirmation after one bounded retry", async () => {
    const methods: string[] = [];
    let getAttempts = 0;
    const client = createConnectWiseClient(credentials, {
      fetcher: async (_input, init) => {
        const method = init?.method ?? "GET";
        methods.push(method);
        if (method === "POST") {
          return Response.json({ id: 901 }, { status: 201 });
        }
        getAttempts += 1;
        return getAttempts === 1
          ? new Response(null, { status: 503 })
          : Response.json({ id: 901, recordType: "Ticket", recordId: 77 });
      },
      sleep: async () => {},
    });

    await expect(
      client.attachImageToTicket(77, {
        filename: "image.png",
        base64: "iVBORw0KGgo=",
        mimeType: "image/png",
      }),
    ).resolves.toEqual({ id: 901 });
    expect(methods).toEqual(["POST", "GET", "GET"]);
  });

  it("treats an unavailable created-document confirmation as indeterminate without repeating the write", async () => {
    const methods: string[] = [];
    const client = createConnectWiseClient(credentials, {
      fetcher: async (_input, init) => {
        const method = init?.method ?? "GET";
        methods.push(method);
        if (method === "POST") {
          return Response.json({ id: 901 }, { status: 201 });
        }
        return new Response(null, { status: 404 });
      },
    });

    await expect(
      client.attachImageToTicket(77, {
        filename: "image.png",
        base64: "iVBORw0KGgo=",
        mimeType: "image/png",
      }),
    ).rejects.toBeInstanceOf(ConnectWiseIndeterminateWriteError);
    expect(methods).toEqual(["POST", "GET"]);
  });

  it("scopes and verifies object schedule reads at the upstream boundary", async () => {
    let capturedUrl = "";
    const client = createConnectWiseClient(credentials, {
      fetcher: async (input) => {
        capturedUrl = String(input);
        return Response.json([{ id: 81, member: { id: 149 }, objectId: 123 }]);
      },
    });

    await expect(client.openScheduleEntriesForObject(123)).resolves.toEqual([
      { id: 81, member: { id: 149 } },
    ]);
    const url = new URL(capturedUrl);
    expect(url.pathname).toBe("/v4_6_release/apis/3.0/schedule/entries");
    expect(url.searchParams.get("conditions")).toBe(
      "objectId=123 and member/id=149",
    );
    expect(url.searchParams.getAll("fields")).toEqual([
      `${scheduleEntryCollectionFields},objectId`,
    ]);
    expect(url.searchParams.get("pageSize")).toBe("50");
  });

  it("rejects object schedule reads without a mapped member before fetch", async () => {
    let requests = 0;
    const client = createConnectWiseClient(
      { ...credentials, memberId: undefined },
      {
        fetcher: async () => {
          requests += 1;
          return Response.json([]);
        },
      },
    );

    await expect(client.openScheduleEntriesForObject(123)).rejects.toThrow(
      "ConnectWise profile is missing memberId; add it to enable open_schedule_entries_for_object",
    );
    expect(requests).toBe(0);
  });

  it("rejects object schedule results for another object or member", async () => {
    const responses = [
      [{ id: 81, member: { id: 149 }, objectId: 124 }],
      [{ id: 82, member: { id: 150 }, objectId: 123 }],
      [{ id: 83, member: { id: 149 } }],
      [{ id: 84, objectId: 123 }],
    ];
    const client = createConnectWiseClient(credentials, {
      fetcher: async () => Response.json(responses.shift()),
    });

    await expect(client.openScheduleEntriesForObject(123)).rejects.toThrow(
      "ConnectWise schedule entry is not associated with requested object",
    );
    await expect(client.openScheduleEntriesForObject(123)).rejects.toThrow(
      "ConnectWise record is not assigned to mapped member",
    );
    await expect(client.openScheduleEntriesForObject(123)).rejects.toThrow(
      "ConnectWise schedule entry is not associated with requested object",
    );
    await expect(client.openScheduleEntriesForObject(123)).rejects.toThrow(
      "ConnectWise record is not assigned to mapped member",
    );
  });

  it.each([
    [
      "zero-length",
      "2026-09-01T12:00:00-04:00",
      "2026-09-01T16:00:00Z",
      /time entry end must be after start/,
    ],
    [
      "reversed",
      "2026-09-01T13:00:00-04:00",
      "2026-09-01T12:00:00-04:00",
      /time entry end must be after start/,
    ],
    [
      "longer than 24 hours",
      "2026-09-01T12:00:00-04:00",
      "2026-09-02T12:00:01-04:00",
      /time entry duration must not exceed 24 hours/,
    ],
  ])(
    "rejects a %s time-entry interval before any request",
    async (_case, timeStart, timeEnd, message) => {
      let requests = 0;
      const client = createConnectWiseClient(credentials, {
        fetcher: async () => {
          requests += 1;
          return Response.json([]);
        },
      });

      await expect(
        client.createTimeEntry({ timeStart, timeEnd }),
      ).rejects.toThrow(message);
      expect(requests).toBe(0);
    },
  );

  it("rejects createTimeEntry when a timesheet is pending approval", async () => {
    let capturedSheetUrl = "";
    const client = createConnectWiseClient(credentials, {
      fetcher: async (_input, init) => {
        const url = String(_input);
        if (url.includes("/time/sheets")) {
          capturedSheetUrl = url;
          return Response.json([
            { id: 99, status: "PendingApproval", period: 43 },
          ]);
        }
        return Response.json({ id: 1 });
      },
    });
    await expect(
      client.createTimeEntry({
        timeStart: "2026-09-01T12:00:00-04:00",
        timeEnd: "2026-09-01T13:00:00-04:00",
      }),
    ).rejects.toThrow(/pending approval/);
    const sheetUrl = new URL(capturedSheetUrl);
    expect(sheetUrl.searchParams.get("conditions")).toBe("member/id=149");
    expect(sheetUrl.searchParams.getAll("fields")).toEqual(["status"]);
    expect(sheetUrl.searchParams.get("pageSize")).toBe("5");
  });

  it("verifies the created time entry identity and mapped member", async () => {
    const created = {
      id: 123,
      member: { id: 149, name: "mapped-member" },
      timeStart: "2026-09-01T16:00:00Z",
      timeEnd: "2026-09-01T17:00:00Z",
      notes: "completed work",
    };
    const client = createConnectWiseClient(credentials, {
      fetcher: async (input) =>
        String(input).includes("/time/sheets")
          ? Response.json([])
          : Response.json(created, { status: 201 }),
    });

    await expect(
      client.createTimeEntry({
        timeStart: "2026-09-01T12:00:00-04:00",
        timeEnd: "2026-09-01T13:00:00-04:00",
      }),
    ).resolves.toEqual(created);
  });

  it.each([
    null,
    [],
    "unexpected",
    {},
    { id: 0, member: { id: 149 } },
    { id: -1, member: { id: 149 } },
    { id: 1.5, member: { id: 149 } },
    { id: Number.MAX_SAFE_INTEGER + 1, member: { id: 149 } },
  ])("rejects malformed created time entry responses: %j", async (created) => {
    const client = createConnectWiseClient(credentials, {
      fetcher: async (input) =>
        String(input).includes("/time/sheets")
          ? Response.json([])
          : Response.json(created, { status: 201 }),
    });

    await expect(
      client.createTimeEntry({
        timeStart: "2026-09-01T12:00:00-04:00",
        timeEnd: "2026-09-01T13:00:00-04:00",
      }),
    ).rejects.toBeInstanceOf(ConnectWiseIndeterminateWriteError);
  });

  it.each([
    { id: 123 },
    { id: 123, member: { id: "149" } },
    { id: 123, member: { id: 150 } },
  ])(
    "rejects created time entries outside the mapped member: %j",
    async (created) => {
      const client = createConnectWiseClient(credentials, {
        fetcher: async (input) =>
          String(input).includes("/time/sheets")
            ? Response.json([])
            : Response.json(created, { status: 201 }),
      });

      await expect(
        client.createTimeEntry({
          timeStart: "2026-09-01T12:00:00-04:00",
          timeEnd: "2026-09-01T13:00:00-04:00",
        }),
      ).rejects.toBeInstanceOf(ConnectWiseIndeterminateWriteError);
    },
  );

  it.each([
    [
      "start",
      {
        id: 123,
        member: { id: 149 },
        timeStart: "2026-09-01T16:00:01Z",
        timeEnd: "2026-09-01T17:00:00Z",
      },
    ],
    [
      "end",
      {
        id: 123,
        member: { id: 149 },
        timeStart: "2026-09-01T16:00:00Z",
        timeEnd: "2026-09-01T17:00:01Z",
      },
    ],
  ])(
    "classifies a mismatched created time-entry %s as indeterminate",
    async (_field, created) => {
      const client = createConnectWiseClient(credentials, {
        fetcher: async (input) =>
          String(input).includes("/time/sheets")
            ? Response.json([])
            : Response.json(created, { status: 201 }),
      });

      await expect(
        client.createTimeEntry({
          timeStart: "2026-09-01T12:00:00-04:00",
          timeEnd: "2026-09-01T13:00:00-04:00",
        }),
      ).rejects.toBeInstanceOf(ConnectWiseIndeterminateWriteError);
    },
  );

  it("classifies a wrong charge target in a created time entry as indeterminate", async () => {
    const client = createConnectWiseClient(credentials, {
      fetcher: async (input) =>
        String(input).includes("/time/sheets")
          ? Response.json([])
          : Response.json({
              id: 123,
              member: { id: 149 },
              chargeToId: 7,
            }),
    });

    await expect(
      client.createTimeEntry({
        timeStart: "2026-09-01T12:00:00-04:00",
        timeEnd: "2026-09-01T13:00:00-04:00",
        chargeToId: 13,
      }),
    ).rejects.toBeInstanceOf(ConnectWiseIndeterminateWriteError);
  });

  it("downloads a document as bounded base64 and rejects oversized bodies", async () => {
    const client = createConnectWiseClient(credentials, {
      fetcher: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("ABC"));
              controller.close();
            },
          }),
          { status: 200, headers: { "Content-Type": "application/pdf" } },
        ),
    });

    await expect(client.downloadDocument(400)).resolves.toEqual({
      base64: btoa("ABC"),
      mimeType: "application/pdf",
      byteLength: 3,
    });

    const unsafeMimeType = createConnectWiseClient(credentials, {
      fetcher: async () =>
        new Response("ABC", {
          status: 200,
          headers: { "Content-Type": `text/plain-${"x".repeat(200)}` },
        }),
    });
    await expect(unsafeMimeType.downloadDocument(400)).resolves.toEqual({
      base64: btoa("ABC"),
      mimeType: "application/octet-stream",
      byteLength: 3,
    });

    const oversizedLogs: string[] = [];
    const oversized = createConnectWiseClient(credentials, {
      fetcher: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(MAX_DOWNLOAD_BYTES + 1));
              controller.close();
            },
          }),
          { status: 200 },
        ),
      log: (message) => oversizedLogs.push(message),
    });
    await expect(oversized.downloadDocument(400)).rejects.toThrow(
      "ConnectWise download too large",
    );
    expect(oversizedLogs).toHaveLength(1);
    expect(JSON.parse(oversizedLogs[0]!)).toMatchObject({
      event: "cw_request",
      method: "GET",
      status: 200,
      outcome: "upstream_error",
    });

    let cancelled = false;
    const declaredOversized = createConnectWiseClient(credentials, {
      fetcher: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          {
            status: 200,
            headers: { "Content-Length": String(MAX_DOWNLOAD_BYTES + 1) },
          },
        ),
    });
    await expect(declaredOversized.downloadDocument(400)).rejects.toThrow(
      "ConnectWise download too large",
    );
    expect(cancelled).toBe(true);
  });

  it("sanitizes document stream failures and emits one allowlisted request log", async () => {
    const logs: string[] = [];
    const sensitiveMarker = "sensitive stream failure";
    let pullCount = 0;
    const client = createConnectWiseClient(credentials, {
      fetcher: async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              pullCount += 1;
              if (pullCount === 1) {
                controller.enqueue(new TextEncoder().encode("partial"));
                return;
              }
              controller.error(new Error(sensitiveMarker));
            },
          }),
          { status: 200 },
        ),
      log: (message) => logs.push(message),
    });

    await expect(client.downloadDocument(400)).rejects.toThrow(
      "ConnectWise download unavailable",
    );
    expect(pullCount).toBe(2);
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0]!)).toEqual({
      event: "cw_request",
      method: "GET",
      status: 200,
      latencyMs: expect.any(Number),
      outcome: "upstream_error",
    });
    expect(logs[0]).not.toContain(sensitiveMarker);
    expect(logs[0]).not.toContain(credentials.companyId);
    expect(logs[0]).not.toContain(credentials.publicKey);
    expect(logs[0]).not.toContain(credentials.privateKey);
    expect(logs[0]).not.toContain(credentials.clientId);
  });

  it("emits one allowlisted request log for a successful document download", async () => {
    const logs: string[] = [];
    const documentId = 987654321;
    const client = createConnectWiseClient(credentials, {
      fetcher: async () =>
        new Response("ABC", {
          status: 200,
          headers: { "Content-Type": "application/pdf" },
        }),
      log: (message) => logs.push(message),
    });

    await expect(client.downloadDocument(documentId)).resolves.toMatchObject({
      byteLength: 3,
      mimeType: "application/pdf",
    });

    expect(logs).toHaveLength(1);
    const requestLog = JSON.parse(logs[0]!) as Record<string, unknown>;
    expect(Object.keys(requestLog).sort()).toEqual([
      "event",
      "latencyMs",
      "method",
      "outcome",
      "status",
    ]);
    expect(requestLog).toMatchObject({
      event: "cw_request",
      method: "GET",
      outcome: "success",
      status: 200,
    });
    expect(logs[0]).not.toContain(String(documentId));
    expect(logs[0]).not.toContain("application/pdf");
    expect(logs[0]).not.toContain("api-na.myconnectwise.net");
    expect(logs[0]).not.toContain(credentials.companyId);
    expect(logs[0]).not.toContain(credentials.publicKey);
    expect(logs[0]).not.toContain(credentials.privateKey);
    expect(logs[0]).not.toContain(credentials.clientId);
    expect(logs[0]).not.toContain("ABC");
  });

  it.each([
    {
      label: "an unavailable request",
      fetcher: async () => {
        throw new Error("sensitive fetch failure");
      },
      expectedMessage: "ConnectWise request unavailable",
      status: null,
      outcome: "unavailable",
    },
    {
      label: "a refused redirect",
      fetcher: async () => new Response(null, { status: 302 }),
      expectedMessage:
        "ConnectWise redirected the download (302); redirects are not followed",
      status: 302,
      outcome: "redirect_refused",
    },
    {
      label: "an upstream error",
      fetcher: async () => new Response("sensitive body", { status: 403 }),
      expectedMessage: "ConnectWise download failed (403)",
      status: 403,
      outcome: "upstream_error",
    },
  ])(
    "emits an allowlisted request log for $label",
    async ({ fetcher, expectedMessage, status, outcome }) => {
      const logs: string[] = [];
      const client = createConnectWiseClient(credentials, {
        fetcher,
        log: (message) => logs.push(message),
      });

      await expect(client.downloadDocument(400)).rejects.toThrow(
        expectedMessage,
      );

      expect(logs).toHaveLength(1);
      expect(JSON.parse(logs[0]!)).toEqual({
        event: "cw_request",
        method: "GET",
        status,
        latencyMs: expect.any(Number),
        outcome,
      });
      expect(logs[0]).not.toContain("sensitive");
      expect(logs[0]).not.toContain("/system/documents");
    },
  );

  it("keeps document download logging best-effort", async () => {
    const successful = createConnectWiseClient(credentials, {
      fetcher: async () => new Response("ABC"),
      log: () => {
        throw new Error("logger unavailable");
      },
    });
    await expect(successful.downloadDocument(400)).resolves.toMatchObject({
      byteLength: 3,
    });

    const unavailable = createConnectWiseClient(credentials, {
      fetcher: async () => {
        throw new Error("fetch unavailable");
      },
      log: () => {
        throw new Error("logger unavailable");
      },
    });
    await expect(unavailable.downloadDocument(400)).rejects.toThrow(
      "ConnectWise request unavailable",
    );
  });

  it("bounds fragmented document downloads by stream chunk count", async () => {
    const payload = new TextEncoder().encode("ABC");
    const atLimit = createConnectWiseClient(credentials, {
      fetcher: async () =>
        fragmentedResponse(payload, MAX_CONNECTWISE_RESPONSE_CHUNKS, {
          contentType: "application/pdf",
        }),
    });
    await expect(atLimit.downloadDocument(400)).resolves.toEqual({
      base64: btoa("ABC"),
      mimeType: "application/pdf",
      byteLength: 3,
    });

    let cancelled = false;
    const overLimit = createConnectWiseClient(credentials, {
      fetcher: async () =>
        fragmentedResponse(payload, MAX_CONNECTWISE_RESPONSE_CHUNKS + 1, {
          closeAfter: false,
          cancel: () => {
            cancelled = true;
            throw new Error("sensitive cancellation details");
          },
        }),
    });
    await expect(overLimit.downloadDocument(400)).rejects.toThrow(
      "ConnectWise download too large",
    );
    expect(cancelled).toBe(true);
  });

  it("uploads a bounded image document with multipart fields and no manual content type", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const logs: string[] = [];
    const client = createConnectWiseClient(credentials, {
      fetcher: async (input, init) => {
        const method = init?.method ?? "GET";
        if (method === "GET") {
          return Response.json({
            id: 901,
            recordType: "Ticket",
            recordId: 77,
          });
        }
        capturedUrl = String(input);
        capturedInit = init;
        return Response.json(
          {
            id: 901,
            title: "Router photo",
            fileName: "router.png",
            imageFlag: true,
            size: 8,
          },
          { status: 201 },
        );
      },
      log: (message) => logs.push(message),
    });
    const pngSignature = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    let binary = "";
    for (const byte of pngSignature) binary += String.fromCharCode(byte);

    await expect(
      client.uploadImageDocument("Ticket", 77, {
        fileName: "router.png",
        mimeType: "image/png",
        base64: btoa(binary),
        title: "Router photo",
        privateFlag: true,
      }),
    ).resolves.toMatchObject({ id: 901, fileName: "router.png" });

    expect(capturedUrl).toBe(
      "https://api-na.myconnectwise.net/v4_6_release/apis/3.0/system/documents",
    );
    expect(capturedInit?.method).toBe("POST");
    expect(capturedInit?.redirect).toBe("manual");
    const headers = new Headers(capturedInit?.headers);
    expect(headers.has("Content-Type")).toBe(false);
    const body = capturedInit?.body;
    expect(body).toBeInstanceOf(FormData);
    if (!(body instanceof FormData)) throw new Error("Expected multipart body");
    expect(body.get("recordType")).toBe("Ticket");
    expect(body.get("recordId")).toBe("77");
    expect(body.get("title")).toBe("Router photo");
    expect(body.get("privateFlag")).toBe("true");
    const file = body.get("file");
    expect(file).toBeInstanceOf(File);
    if (!(file instanceof File)) throw new Error("Expected image file");
    expect(file.name).toBe("router.png");
    expect(file.type).toBe("image/png");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(pngSignature);
    const postLog = logs.find((line) => {
      const entry = JSON.parse(line) as Record<string, unknown>;
      return entry.method === "POST";
    });
    expect(postLog).toBeDefined();
    const requestLog = JSON.parse(postLog!) as Record<string, unknown>;
    expect(Object.keys(requestLog).sort()).toEqual([
      "event",
      "latencyMs",
      "method",
      "outcome",
      "status",
    ]);
    expect(requestLog).toMatchObject({
      event: "cw_request",
      method: "POST",
      outcome: "success",
      status: 201,
    });
    expect(logs[0]).not.toContain("Router photo");
    expect(logs[0]).not.toContain("router.png");
    expect(logs[0]).not.toContain("api-na.myconnectwise.net");
  });

  it.each([
    {
      label: "a fetch failure",
      fetcher: async () => {
        throw new Error("response lost after upload");
      },
    },
    {
      label: "an upstream timeout response",
      fetcher: async () => new Response(null, { status: 408 }),
    },
    {
      label: "an upstream server error",
      fetcher: async () => new Response(null, { status: 503 }),
    },
    {
      label: "a redirect response",
      fetcher: async () => new Response(null, { status: 302 }),
    },
    {
      label: "an accepted asynchronous response",
      fetcher: async () =>
        Response.json(
          { id: 901, recordId: 77, recordType: "Ticket" },
          { status: 202 },
        ),
    },
    {
      label: "an empty success response",
      fetcher: async () => new Response(null, { status: 201 }),
    },
    {
      label: "a malformed success response",
      fetcher: async () => new Response("not json", { status: 201 }),
    },
    {
      label: "an unverified success response",
      fetcher: async () => Response.json({}, { status: 201 }),
    },
    {
      label: "a wrong-target success response",
      fetcher: async () =>
        Response.json(
          { id: 9, recordId: 78, recordType: "Ticket" },
          { status: 201 },
        ),
    },
    {
      label: "an oversized success response",
      fetcher: async () =>
        new Response("{}", {
          status: 201,
          headers: { "Content-Length": "1000001" },
        }),
    },
    {
      label: "an unreadable success response",
      fetcher: async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.error(new Error("sensitive upload stream failure"));
            },
          }),
          { status: 201 },
        ),
    },
  ] satisfies Array<{ label: string; fetcher: typeof fetch }>)(
    "classifies an ambiguous image upload caused by $label without retrying",
    async ({ fetcher }: { fetcher: typeof fetch }) => {
      let attempts = 0;
      const logs: string[] = [];
      const client = createConnectWiseClient(credentials, {
        fetcher: async (input, init) => {
          attempts += 1;
          return fetcher(input, init);
        },
        log: (line) => logs.push(line),
      });
      const pngSignature = String.fromCharCode(
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a,
      );

      await expect(
        client.uploadImageDocument("Ticket", 77, {
          fileName: "router.png",
          mimeType: "image/png",
          base64: btoa(pngSignature),
          privateFlag: true,
        }),
      ).rejects.toBeInstanceOf(ConnectWiseIndeterminateWriteError);
      expect(attempts).toBe(1);
      expect(logs).toHaveLength(1);
      const requestLog = JSON.parse(logs[0]!) as Record<string, unknown>;
      expect(Object.keys(requestLog).sort()).toEqual([
        "event",
        "latencyMs",
        "method",
        "outcome",
        "status",
      ]);
      expect(requestLog).toMatchObject({
        event: "cw_request",
        method: "POST",
      });
      expect(requestLog.outcome).not.toBe("success");
      expect(logs[0]).not.toContain("router.png");
      expect(logs[0]).not.toContain(credentials.privateKey);
    },
  );

  it("cancels image-upload error bodies without retaining their contents", async () => {
    let cancelled = false;
    const client = createConnectWiseClient(credentials, {
      fetcher: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  '{"message":"upload denied","privateKey":"secret value"}',
                ),
              );
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 403 },
        ),
    });
    const pngSignature = String.fromCharCode(
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
    );

    let error: unknown;
    try {
      await client.uploadImageDocument("Ticket", 77, {
        fileName: "router.png",
        mimeType: "image/png",
        base64: btoa(pngSignature),
        privateFlag: true,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ConnectWiseRequestError);
    if (!(error instanceof ConnectWiseRequestError)) {
      throw new Error("Expected client error");
    }
    expect(error.message).toBe(
      "ConnectWise request failed (403) at POST /system/documents",
    );
    expect(JSON.stringify(error)).not.toContain("upload denied");
    expect(JSON.stringify(error)).not.toContain("secret value");
    expect(cancelled).toBe(true);
  });

  it("rejects spoofed, mismatched, and oversized image uploads before fetch", async () => {
    let requests = 0;
    const client = createConnectWiseClient(credentials, {
      fetcher: async () => {
        requests += 1;
        return Response.json({}, { status: 201 });
      },
    });

    await expect(
      client.uploadImageDocument("TimeEntry", 88, {
        fileName: "spoof.png",
        mimeType: "image/png",
        base64: btoa("not a png"),
        privateFlag: true,
      }),
    ).rejects.toThrow("does not match the declared MIME type");

    const pngSignature = String.fromCharCode(
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
    );
    await expect(
      client.uploadImageDocument("Ticket", 77, {
        fileName: "wrong.jpg",
        mimeType: "image/png",
        base64: btoa(pngSignature),
        privateFlag: true,
      }),
    ).rejects.toThrow("extension does not match MIME type");

    await expect(
      client.uploadImageDocument("Ticket", 77, {
        fileName: "huge.png",
        mimeType: "image/png",
        base64: "A".repeat(4 * Math.ceil(MAX_IMAGE_UPLOAD_BYTES / 3) + 4),
        privateFlag: true,
      }),
    ).rejects.toThrow("Invalid or oversized image data");
    expect(requests).toBe(0);
  });

  it("classifies an image-upload redirect as indeterminate without retrying the POST", async () => {
    let requests = 0;
    const client = createConnectWiseClient(credentials, {
      fetcher: async () => {
        requests += 1;
        return new Response(null, {
          status: 302,
          headers: { Location: "https://example.invalid/redirect" },
        });
      },
    });
    const pngSignature = String.fromCharCode(
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
    );

    await expect(
      client.uploadImageDocument("Ticket", 77, {
        fileName: "router.png",
        mimeType: "image/png",
        base64: btoa(pngSignature),
        privateFlag: true,
      }),
    ).rejects.toBeInstanceOf(ConnectWiseIndeterminateWriteError);
    expect(requests).toBe(1);
  });

  it("enforces image signatures, canonical base64, and exact decoded-size bounds", () => {
    const signatures = [
      ["image/png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
      ["image/jpeg", [0xff, 0xd8, 0xff]],
      ["image/gif", [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]],
      ["image/gif", [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]],
      [
        "image/webp",
        [
          0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42,
          0x50,
        ],
      ],
    ] as const;
    const binary = (bytes: readonly number[]) => String.fromCharCode(...bytes);

    for (const [mimeType, signature] of signatures) {
      expect(
        decodeConnectWiseImageBase64(btoa(binary(signature)), mimeType),
      ).toEqual(new Uint8Array(signature));
    }

    for (const nonCanonical of [
      "iVBORw0KGgo",
      "iVBORw0KGgo===",
      "iVBORw0K Ggo=",
      "iVBORw0KGgp=",
    ]) {
      expect(() =>
        decodeConnectWiseImageBase64(nonCanonical, "image/png"),
      ).toThrow();
    }

    const pngSignature = binary(signatures[0][1]);
    const exactLimit = btoa(
      pngSignature + "\0".repeat(MAX_IMAGE_UPLOAD_BYTES - pngSignature.length),
    );
    expect(decodeConnectWiseImageBase64(exactLimit, "image/png")).toHaveLength(
      MAX_IMAGE_UPLOAD_BYTES,
    );
    expect(() =>
      decodeConnectWiseImageBase64(
        btoa(
          pngSignature +
            "\0".repeat(MAX_IMAGE_UPLOAD_BYTES - pngSignature.length + 1),
        ),
        "image/png",
      ),
    ).toThrow("Invalid or oversized image data");
  });

  const imagePayload = {
    filename: "shot.png",
    base64: "iVBORw0KGgo=",
    mimeType: "image/png",
  };

  it("posts a ticket image attachment as the fixed JSON payload", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const client = createConnectWiseClient(credentials, {
      fetcher: async (input, init) => {
        const method = init?.method ?? "GET";
        if (method === "GET") {
          return Response.json({ id: 55, recordType: "Ticket", recordId: 77 });
        }
        capturedUrl = String(input);
        capturedInit = init;
        return Response.json({ id: 55 });
      },
    });

    await expect(client.attachImageToTicket(77, imagePayload)).resolves.toEqual(
      { id: 55 },
    );
    expect(capturedUrl).toBe(
      "https://api-na.myconnectwise.net/v4_6_release/apis/3.0/service/tickets/77/attachments",
    );
    expect(capturedInit?.method).toBe("POST");
    expect(JSON.parse(String(capturedInit?.body))).toEqual({
      filename: "shot.png",
      fileContents: "iVBORw0KGgo=",
      fileType: "image/png",
    });
  });

  it("posts a time-entry image attachment to the time-entry path", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const calls: string[] = [];
    const client = createConnectWiseClient(credentials, {
      fetcher: async (input, init) => {
        const method =
          (init as { method?: string } | undefined)?.method ?? "GET";
        calls.push(`${method} ${String(input)}`);
        if (method === "GET") {
          const url = new URL(String(input));
          if (url.pathname.endsWith("/system/documents/66")) {
            return Response.json({
              id: 66,
              recordType: "TimeEntry",
              recordId: 42,
            });
          }
          return Response.json({ id: 42, member: { id: 149 } });
        }
        capturedUrl = String(input);
        capturedInit = init;
        return Response.json({ id: 66 });
      },
    });

    await expect(
      client.attachImageToTimeEntry(42, imagePayload),
    ).resolves.toEqual({ id: 66 });
    expect(calls[0]).toBe(
      "GET https://api-na.myconnectwise.net/v4_6_release/apis/3.0/time/entries/42?fields=id%2Cmember",
    );
    expect(capturedUrl).toBe(
      "https://api-na.myconnectwise.net/v4_6_release/apis/3.0/timeentries/42/attachments",
    );
    expect(capturedInit?.method).toBe("POST");
  });

  it("rejects unsupported image types and unsafe filenames without a request", async () => {
    let requests = 0;
    const client = createConnectWiseClient(credentials, {
      fetcher: async () => {
        requests += 1;
        return Response.json({});
      },
    });

    await expect(
      client.attachImageToTicket(77, {
        ...imagePayload,
        mimeType: "application/pdf",
      }),
    ).rejects.toThrow("Unsupported image type");
    await expect(
      client.attachImageToTicket(77, {
        ...imagePayload,
        base64: "not base64!",
      }),
    ).rejects.toThrow("Invalid or oversized image data");
    await expect(
      client.attachImageToTicket(77, {
        ...imagePayload,
        base64: "SGVsbG8=",
      }),
    ).rejects.toThrow("does not match the declared MIME type");
    await expect(
      client.attachImageToTicket(77, {
        ...imagePayload,
        base64: btoa(
          String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) +
            "A".repeat(MAX_IMAGE_UPLOAD_BYTES - 7),
        ),
      }),
    ).rejects.toThrow("Invalid or oversized image data");
    await expect(
      client.attachImageToTimeEntry(42, {
        ...imagePayload,
        filename: "../escape.png",
      }),
    ).rejects.toThrow("Invalid attachment filename");
    expect(requests).toBe(0);
  });

  it("does not switch ticket write namespaces when a service route is missing", async () => {
    const attachmentUrls: string[] = [];
    const attachmentClient = createConnectWiseClient(credentials, {
      fetcher: async (input) => {
        attachmentUrls.push(String(input));
        return new Response(null, { status: 404 });
      },
    });

    await expect(
      attachmentClient.attachImageToTicket(77, imagePayload),
    ).rejects.toThrow("ConnectWise request failed (404)");
    expect(attachmentUrls).toEqual([
      "https://api-na.myconnectwise.net/v4_6_release/apis/3.0/service/tickets/77/attachments",
    ]);

    const noteUrls: string[] = [];
    const noteClient = createConnectWiseClient(credentials, {
      fetcher: async (input) => {
        noteUrls.push(String(input));
        return new Response(null, { status: 404 });
      },
    });

    await expect(
      noteClient.createTicketNote(77, {
        text: "Customer called",
        internalOnly: true,
        resolutionNote: false,
        issueNote: false,
      }),
    ).rejects.toThrow("ConnectWise request failed (404)");
    expect(noteUrls).toEqual([
      "https://api-na.myconnectwise.net/v4_6_release/apis/3.0/service/tickets/77/notes",
    ]);
  });
});
