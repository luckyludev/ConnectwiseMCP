import { describe, expect, it } from "vitest";
import {
  ConnectWiseRequestError,
  MAX_IMAGE_UPLOAD_BYTES,
  createConnectWiseClient,
  ghostScheduleEntries,
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

describe("ConnectWiseClient", () => {
  it("gets one service ticket with request-scoped authentication", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetcher: typeof fetch = async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return Response.json({ id: 123, summary: "Printer offline" });
    };
    const client = createConnectWiseClient(credentials, { fetcher });

    await expect(client.getServiceTicket(123)).resolves.toEqual({
      id: 123,
      summary: "Printer offline",
    });
    expect(capturedUrl).toBe(
      "https://api-na.myconnectwise.net/v4_6_release/apis/3.0/service/tickets/123",
    );
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

  it("surfaces a bounded, scrubbed error body preview without hanging", async () => {
    let attempts = 0;
    let cancelled = false;
    const client = createConnectWiseClient(credentials, {
      fetcher: async () => {
        attempts += 1;
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  '{"code":"Forbidden","message":"Access denied","authorization":"Basic dXNlcjpwYXNzInZhbHVl"}',
                ),
              );
              // Deliberately never closes: the preview must not hang.
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
    expect(error.message).toContain("ConnectWise request failed (401)");
    expect(error.message).toContain("at GET /service/tickets/123");
    expect(error.message).toContain("Forbidden");
    expect(error.message).toContain("Access denied");
    expect(error.message).not.toContain("dXNlcjpwYXNzInZhbHVl");
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

  it("escapes ticket-search conditions and enforces the result bound", async () => {
    let capturedUrl = "";
    const client = createConnectWiseClient(credentials, {
      fetcher: async (input) => {
        capturedUrl = String(input);
        return Response.json([]);
      },
    });

    await client.searchServiceTickets("Luis's laptop", 12);
    const url = new URL(capturedUrl);
    expect(url.pathname).toBe("/v4_6_release/apis/3.0/service/tickets");
    expect(url.searchParams.get("conditions")).toBe(
      "summary contains 'Luis''s laptop'",
    );
    expect(url.searchParams.get("pageSize")).toBe("12");
    await expect(client.searchServiceTickets("x", 51)).rejects.toThrow(
      "Invalid page size",
    );
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
        urls.push(String(input));
        return Response.json([]);
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

    await client.listBoardTickets(32, 10);
    expect(new URL(urls[2]!).searchParams.get("conditions")).toBe(
      "board/id=32",
    );

    await client.getServiceStatuses();
    expect(new URL(urls[3]!).pathname).toBe(
      "/v4_6_release/apis/3.0/service/statuses",
    );

    await client.getMyMember();
    expect(new URL(urls[4]!).pathname).toBe(
      "/v4_6_release/apis/3.0/system/members/149",
    );

    await client.listTimeEntries(5);
    expect(new URL(urls[5]!).pathname).toBe(
      "/v4_6_release/apis/3.0/time/entries",
    );
  });

  it("escapes company and contact search conditions", async () => {
    let url = "";
    const client = createConnectWiseClient(credentials, {
      fetcher: async (input) => {
        url = String(input);
        return Response.json([]);
      },
    });

    await client.searchCompanies("O'Brien", 10);
    expect(new URL(url).searchParams.get("conditions")).toBe(
      "name like '%O''Brien%'",
    );

    await client.searchContacts("a@b.com", 10);
    expect(new URL(url).searchParams.get("conditions")).toBe(
      "(name like '%a@b.com%' OR email like '%a@b.com%')",
    );
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

    await client.catalogGet("system.documents", {
      recordType: "Ticket",
      recordId: 77,
      pageSize: 20,
    });
    expect(new URL(urls[1]!).searchParams.get("recordType")).toBe("Ticket");
    expect(new URL(urls[1]!).searchParams.get("recordId")).toBe("77");

    await expect(
      client.catalogGet("finance.invoices.byRaw", { pageSize: 5 }),
    ).rejects.toThrow("Unknown ConnectWise route");

    await expect(
      client.catalogGet("system.documents", { recordType: "Raw", recordId: 7 }),
    ).rejects.toThrow("Unsupported document record type");

    await expect(
      client.catalogGet("service.boards.statuses", { pageSize: 5 }),
    ).rejects.toThrow("Missing boardId");
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

    await client.catalogGet("schedule.entries.byMember", {
      memberId: 149,
      startDate: "2026-08-01",
      pageSize: 20,
    });
    expect(new URL(urls[1]!).searchParams.get("conditions")).toBe(
      "member/id=149 and dateStart >= [2026-08-01]",
    );

    await expect(
      client.catalogGet("schedule.entries.byMember", {
        memberId: 149,
        startDate: "2026-08-15",
        endDate: "2026-08-01",
      }),
    ).rejects.toThrow("endDate must be on or after startDate");

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
      }),
    ).rejects.toThrow("Invalid startDate");
  });

  it("sends no orderBy on schedule entries and sorts them in the worker", async () => {
    const urls: string[] = [];
    const client = createConnectWiseClient(credentials, {
      fetcher: async (input) => {
        urls.push(String(input));
        return Response.json([
          { id: 2, dateStart: "2026-09-02T13:30:00Z" },
          { id: 1, dateStart: "2026-08-31T18:15:00Z" },
          { id: 3, dateStart: "2026-09-01T12:30:00Z" },
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
      { id: 1, dateStart: "2026-08-31T18:15:00Z" },
      { id: 3, dateStart: "2026-09-01T12:30:00Z" },
      { id: 2, dateStart: "2026-09-02T13:30:00Z" },
    ]);
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
      memberId: 149,
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
        memberId: 149,
        dateStart: "2026-08-31T12:30:00",
        dateEnd: "2026-08-31T17:00:00",
      }),
    ).rejects.toThrow(/explicit timezone offset/);

    await expect(
      client.createScheduleEntry({
        memberId: 149,
        dateStart: "2026-08-31T12:30:00-04:00",
        dateEnd: "2026-08-31T17:00:00-04:00",
      }),
    ).rejects.toThrow(/objectId is required/);
  });

  it("ghostScheduleEntries detects zero-hour same-start/end entries only", () => {
    const ghosts = ghostScheduleEntries([
      {
        id: 246998,
        dateStart: "2026-09-03T00:00:00Z",
        dateEnd: "2026-09-03T00:00:00Z",
        hours: null,
      },
      {
        id: 1,
        dateStart: "2026-09-03T00:00:00Z",
        dateEnd: "2026-09-03T00:00:00Z",
        hours: 0,
      },
      {
        id: 2,
        dateStart: "2026-09-03T00:00:00Z",
        dateEnd: "2026-09-03T02:00:00Z",
        hours: null,
      },
      {
        id: 3,
        dateStart: "2026-09-03T00:00:00Z",
        dateEnd: "2026-09-03T00:00:00Z",
        hours: 2,
      },
      { id: 4, dateStart: null, dateEnd: null, hours: 0.0 },
    ]);
    expect(ghosts.map((g) => g.id)).toEqual([246998, 1, 4]);
  });

  it("logs the scrubbed write payload in cw_request", async () => {
    const logs: string[] = [];
    const client = createConnectWiseClient(credentials, {
      fetcher: async () => Response.json({}),
      log: (message) => logs.push(message),
    });
    await client.createScheduleEntry({
      memberId: 149,
      objectId: 1892065,
      objectType: 4,
      dateStart: "2026-08-31T08:30:00-04:00",
      dateEnd: "2026-08-31T17:00:00-04:00",
      name: "Sync test",
    });
    const logLine = logs.find((l) => l.includes("cw_request"))!;
    expect(logLine).toContain('"requestBody"');
    expect(logLine).toContain("2026-08-31T12:30:00Z");
    expect(logLine).not.toContain("public-key");
  });

  it("updates a schedule entry via GET-then-merge PUT, preserving unpassed fields", async () => {
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
          });
        }
        return Response.json({ id: 9 });
      },
    });

    await client.updateScheduleEntry(9, {
      dateStart: "2026-09-01T12:00:00-04:00",
    });
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put).toBeDefined();
    const body = put.body as Record<string, unknown>;
    expect(body.dateStart).toBe("2026-09-01T16:00:00Z");
    expect(body.name).toBe("Keep me");
    expect(body.doneFlag).toBe(false);
    expect(body.status).toEqual({ id: 1 });
  });

  it("deletes a schedule entry with DELETE", async () => {
    const calls: string[] = [];
    const client = createConnectWiseClient(credentials, {
      fetcher: async (input, init) => {
        calls.push(
          `${
            (init as { method?: string } | undefined)?.method ?? "GET"
          } ${String(input)}`,
        );
        return new Response(null, { status: 204 });
      },
    });
    await client.deleteScheduleEntry(247134);
    expect(calls[0]).toBe(
      "DELETE https://api-na.myconnectwise.net/v4_6_release/apis/3.0/schedule/entries/247134",
    );
  });

  it("rejects createTimeEntry when a timesheet is pending approval", async () => {
    const client = createConnectWiseClient(credentials, {
      fetcher: async (_input, init) => {
        const url = String(_input);
        if (url.includes("/time/sheets")) {
          return Response.json([
            { id: 99, status: "PendingApproval", period: 43 },
          ]);
        }
        return Response.json({ id: 1 });
      },
    });
    await expect(
      client.createTimeEntry({
        memberId: 149,
        timeStart: "2026-09-01T12:00:00-04:00",
        timeEnd: "2026-09-01T13:00:00-04:00",
      }),
    ).rejects.toThrow(/pending approval/);
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

  it("uploads a bounded image document with multipart fields and no manual content type", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
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
    const client = createConnectWiseClient(credentials, {
      fetcher: async (input, init) => {
        capturedUrl = String(input);
        capturedInit = init;
        return Response.json({ id: 66 });
      },
    });

    await expect(
      client.attachImageToTimeEntry(42, imagePayload),
    ).resolves.toEqual({ id: 66 });
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

  it("falls back to the project-ticket attachment path when the service path is missing", async () => {
    const urls: string[] = [];
    const client = createConnectWiseClient(credentials, {
      fetcher: async (input) => {
        urls.push(String(input));
        if (urls.length === 1) return new Response(null, { status: 404 });
        return Response.json({ id: 56 });
      },
    });

    await expect(client.attachImageToTicket(77, imagePayload)).resolves.toEqual(
      { id: 56 },
    );
    expect(urls).toEqual([
      "https://api-na.myconnectwise.net/v4_6_release/apis/3.0/service/tickets/77/attachments",
      "https://api-na.myconnectwise.net/v4_6_release/apis/3.0/project/tickets/77/attachments",
    ]);
  });
});
