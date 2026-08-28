import { describe, expect, it } from "vitest";
import { createConnectWiseClient } from "../src/connectwise-client";
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
    expect(capturedInit?.redirect).toBe("error");
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

  it("does not expose an upstream error body", async () => {
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
                  "credential=[REDACTED]; sensitive customer response",
                ),
              );
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
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("Expected client error");
    expect(error.message).toBe("ConnectWise request failed (401)");
    expect(error.message).not.toContain("sensitive customer response");
    expect(error.message).not.toContain("credential=");
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
});
