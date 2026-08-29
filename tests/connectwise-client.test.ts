import { describe, expect, it } from "vitest";
import {
  ConnectWiseRequestError,
  createConnectWiseClient,
} from "../src/connectwise-client";
import type { ConnectWiseCredentials } from "../src/connectwise-profile";

const credentials: ConnectWiseCredentials = {
  apiBaseUrl: "https://api-na.myconnectwise.net/v4_6_release/apis/3.0",
  companyId: "acme",
  publicKey: "public-key",
  privateKey: "private-key",
  clientId: "partner-client-id",
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
      "/v4_6_release/apis/3.0/system/myMember",
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
      "member/id=149 and start >= '2026-08-01' and start <= '2026-08-15T23:59:59'",
    );

    await client.catalogGet("schedule.entries.byMember", {
      memberId: 149,
      startDate: "2026-08-01",
      pageSize: 20,
    });
    expect(new URL(urls[1]!).searchParams.get("conditions")).toBe(
      "member/id=149 and start >= '2026-08-01'",
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
});
