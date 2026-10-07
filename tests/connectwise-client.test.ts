import { describe, expect, it } from "vitest";
import {
  ConnectWiseIndeterminateWriteError,
  ConnectWiseRequestError,
  MAX_CONNECTWISE_RESPONSE_CHUNKS,
  MAX_IMAGE_UPLOAD_BYTES,
  createConnectWiseClient,
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
const ticketTaskCollectionFields = "id,summary,priority,notes,ticketId";
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

    await expect(client.getTicketNotes(123, 20)).resolves.toEqual([]);
    await expect(client.getTicketTasks(123, 20)).resolves.toEqual([]);

    expect(urls).toHaveLength(2);
    const serviceNotesUrl = new URL(urls[0]!);
    const tasksUrl = new URL(urls[1]!);
    expect(
      serviceNotesUrl.pathname.endsWith("/service/tickets/123/notes"),
    ).toBe(true);
    expect(Object.fromEntries(serviceNotesUrl.searchParams)).toEqual({
      fields: serviceTicketNoteCollectionFields,
      pageSize: "20",
      orderBy: "dateCreated asc",
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

  it("verifies and strips ticket relationships from note results", async () => {
    const client = createConnectWiseClient(credentials, {
      fetcher: async () =>
        Response.json([
          {
            id: 301,
            text: "Customer update",
            ticketId: 123,
          },
        ]),
    });

    await expect(client.getTicketNotes(123, 20)).resolves.toEqual([
      {
        id: 301,
        text: "Customer update",
      },
    ]);
  });

  it.each([
    { id: 301, ticketId: 124 },
    { id: 301 },
    { id: 301, ticketId: "123" },
  ])(
    "rejects a note without the exact requested ticket relationship: %j",
    async (note) => {
      const client = createConnectWiseClient(credentials, {
        fetcher: async () => Response.json([note]),
      });

      await expect(client.getTicketNotes(123, 20)).rejects.toThrow(
        "ConnectWise note is not associated with requested ticket",
      );
    },
  );

  it("rejects a mismatched note later in the bounded result", async () => {
    const client = createConnectWiseClient(credentials, {
      fetcher: async () =>
        Response.json([
          { id: 301, ticketId: 123 },
          { id: 302, ticketId: 124 },
        ]),
    });

    await expect(client.getTicketNotes(123, 20)).rejects.toThrow(
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

    await expect(client.getTicketNotes(123, 20)).rejects.toThrow(
      "ConnectWise request failed (404)",
    );
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

  it("sanitizes malformed successful response bodies", async () => {
    const client = createConnectWiseClient(credentials, {
      fetcher: async () => new Response("sensitive malformed response"),
    });

    await expect(client.getServiceTicket(123)).rejects.toThrow(
      "Invalid ConnectWise response",
    );
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

  it("rejects an oversized response body", async () => {
    const client = createConnectWiseClient(credentials, {
      fetcher: async () =>
        new Response(JSON.stringify({ data: "x".repeat(1_000_001) }), {
          status: 200,
        }),
    });

    await expect(client.getServiceTicket(123)).rejects.toThrow(
      "ConnectWise response too large",
    );
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

  it("retries one safe transient response with a bounded delay", async () => {
    let attempts = 0;
    const delays: number[] = [];
    const client = createConnectWiseClient(credentials, {
      fetcher: async () => {
        attempts += 1;
        if (attempts === 1) return new Response(null, { status: 503 });
        return new Response(JSON.stringify({ id: 123, summary: "Recovered" }), {
          status: 200,
        });
      },
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });

    await expect(client.getServiceTicket(123)).resolves.toEqual({
      id: 123,
      summary: "Recovered",
    });
    expect(attempts).toBe(2);
    expect(delays).toEqual([100]);
  });

  it("stops after two transient responses and cancels both bodies", async () => {
    let attempts = 0;
    let cancellations = 0;
    const delays: number[] = [];
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
    });

    await expect(client.getServiceTicket(123)).rejects.toThrow(
      "ConnectWise request failed (503)",
    );
    expect(attempts).toBe(2);
    expect(cancellations).toBe(2);
    expect(delays).toEqual([100]);
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
          { id: 1, summary: "Repair LUIS'S LAPTOP" },
          { id: 2, summary: "Luis's laptop replacement" },
        ],
      },
      {
        query: "éx",
        records: [{ id: 1, summary: "E\u0301xample printer" }],
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

  it("does not retry a ticket-note write after an ambiguous fetch failure", async () => {
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
    ).rejects.toThrow("ConnectWise request unavailable");
    expect(attempts).toBe(1);
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
        return Response.json({ id: 44 });
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
    const matchingClient = createConnectWiseClient(credentials, {
      fetcher: async () => Response.json([{ id: 1, board: { id: 32 } }]),
    });
    await expect(matchingClient.listBoardTickets(32, 10)).resolves.toEqual([
      { id: 1, board: { id: 32 } },
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
    const matchingClient = createConnectWiseClient(credentials, {
      fetcher: async () => Response.json([{ id: 1, status: { id: 547 } }]),
    });
    await expect(
      matchingClient.catalogGet("service.tickets.byStatus", { statusId: 547 }),
    ).resolves.toEqual([{ id: 1, status: { id: 547 } }]);

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
    ).resolves.toEqual([
      { id: 10, member: { id: 149 }, dateStart: "not-a-date" },
    ]);
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
    expect(first.searchParams.has("orderBy")).toBe(false);

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
        return Response.json({ id: 777, dateStart: "2026-08-31T16:30:00Z" });
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
      fetcher: async () => Response.json({}),
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

  it("does not reconcile a refused service ticket update redirect", async () => {
    const methods: string[] = [];
    const client = createConnectWiseClient(credentials, {
      fetcher: async (_input, init) => {
        const method =
          (init as { method?: string } | undefined)?.method ?? "GET";
        methods.push(method);
        return method === "PATCH"
          ? new Response(null, {
              status: 307,
              headers: { Location: "https://other.example/ticket" },
            })
          : Response.json({ id: 9 });
      },
    });

    await expect(
      client.updateServiceTicket(9, { summary: "Updated" }),
    ).rejects.toThrow("redirected the request (307)");
    expect(methods).toEqual(["GET", "PATCH"]);
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
            dateEnd: "2026-08-31T21:00:00Z",
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
          allowScheduleConflictsFlag: false,
        });
      },
    });

    await client.updateScheduleEntry(9, {
      dateStart: "2026-09-01T12:00:00-04:00",
      allowConflicts: false,
    });
    const get = calls.find((c) => c.method === "GET")!;
    expect(new URL(get.url).searchParams.get("fields")).toBe("id,member");
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
        path: "allowScheduleConflictsFlag",
        value: false,
      },
    ]);
  });

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
    ).rejects.toThrow("ConnectWise schedule entry does not match requested ID");
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
    ).rejects.toThrow("ConnectWise record is not assigned to mapped member");
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

  it("deletes only a schedule entry owned by the mapped member", async () => {
    const calls: string[] = [];
    const client = createConnectWiseClient(credentials, {
      fetcher: async (input, init) => {
        const method =
          (init as { method?: string } | undefined)?.method ?? "GET";
        calls.push(`${method} ${String(input)}`);
        return method === "GET"
          ? Response.json({ id: 247134, member: { id: 149 } })
          : new Response(null, { status: 204 });
      },
    });
    await client.deleteScheduleEntry(247134);
    expect(calls).toEqual([
      "GET https://api-na.myconnectwise.net/v4_6_release/apis/3.0/schedule/entries/247134?fields=id%2Cmember",
      "DELETE https://api-na.myconnectwise.net/v4_6_release/apis/3.0/schedule/entries/247134",
    ]);
  });

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
        base64: "AAAA",
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
                base64: "AAAA",
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
          return Response.json({ id: 42, member: { id: 149 } });
        }
        return Response.json({ id: 901 }, { status: 201 });
      },
    });

    await client.attachImageToTimeEntry(42, {
      filename: "image.png",
      base64: "AAAA",
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
      "POST",
    ]);
    const lookupCalls = calls.filter((call) => call.startsWith("GET "));
    expect(lookupCalls).toHaveLength(2);
    for (const lookupCall of lookupCalls) {
      const lookupUrl = new URL(lookupCall.slice("GET ".length));
      expect(lookupUrl.pathname).toBe("/v4_6_release/apis/3.0/time/entries/42");
      expect(lookupUrl.searchParams.getAll("fields")).toEqual(["id,member"]);
      expect([...lookupUrl.searchParams.keys()]).toEqual(["fields"]);
    }
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
    ).rejects.toThrow("Invalid ConnectWise time entry response");
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
      ).rejects.toThrow("ConnectWise record is not assigned to mapped member");
    },
  );

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

    const oversized = createConnectWiseClient(credentials, {
      fetcher: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(8_000_001));
              controller.close();
            },
          }),
          { status: 200 },
        ),
    });
    await expect(oversized.downloadDocument(400)).rejects.toThrow(
      "ConnectWise download too large",
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
      outcome: "success",
      status: 201,
    });
    expect(logs[0]).not.toContain("Router photo");
    expect(logs[0]).not.toContain("router.png");
    expect(logs[0]).not.toContain("api-na.myconnectwise.net");
  });

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

  it("refuses an image-upload redirect without retrying the POST", async () => {
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
    ).rejects.toThrow("redirects are not followed");
    expect(requests).toBe(1);
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
    ).rejects.toThrow("Invalid image contents");
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
