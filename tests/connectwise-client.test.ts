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
});
