import { describe, expect, it } from "vitest";
import { MAX_MCP_REQUEST_BYTES, prepareMcpRequest } from "../src/mcp-request";

function streamedRequest(
  chunks: Uint8Array[],
  contentLength?: string,
): { request: Request; cancelled: () => number; pulls: () => number } {
  let cancellationCount = 0;
  let pullCount = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[pullCount];
      pullCount += 1;
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
    cancel() {
      cancellationCount += 1;
    },
  });
  const headers = new Headers({ "content-type": "application/json" });
  if (contentLength !== undefined) headers.set("content-length", contentLength);
  const request = new Request("https://worker.example/mcp", {
    method: "POST",
    headers,
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  return {
    request,
    cancelled: () => cancellationCount,
    pulls: () => pullCount,
  };
}

describe("prepareMcpRequest", () => {
  it("rejects a declared oversized body without consuming it", async () => {
    const request = new Request("https://worker.example/mcp", {
      method: "POST",
      headers: { "content-length": String(MAX_MCP_REQUEST_BYTES + 1) },
      body: "{}",
    });

    const result = await prepareMcpRequest(request);

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(413);
    expect((result as Response).headers.get("cache-control")).toBe("no-store");
    expect((result as Response).headers.get("pragma")).toBe("no-cache");
    expect(await (result as Response).text()).toBe("Request body too large");
    expect(request.bodyUsed).toBe(false);
  });

  it.each(["invalid", "+1", "-1", "1.0"])(
    "rejects malformed declared length %s without consuming the body",
    async (contentLength) => {
      const request = new Request("https://worker.example/mcp", {
        method: "POST",
        headers: { "content-length": contentLength },
        body: "{}",
      });

      const result = await prepareMcpRequest(request);

      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(400);
      expect(request.bodyUsed).toBe(false);
    },
  );

  it("accepts a digit-only declared length with leading zeroes", async () => {
    const streamed = streamedRequest([new TextEncoder().encode("{}")], "00010");

    const result = await prepareMcpRequest(streamed.request);

    expect(result).toBeInstanceOf(Request);
    expect(await (result as Request).text()).toBe("{}");
  });

  it("cancels a chunked body immediately after it crosses the limit", async () => {
    const streamed = streamedRequest([
      new Uint8Array(MAX_MCP_REQUEST_BYTES),
      new Uint8Array(1),
      new Uint8Array(1),
    ]);

    const result = await prepareMcpRequest(streamed.request);

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(413);
    expect(streamed.pulls()).toBe(2);
    expect(streamed.cancelled()).toBe(1);
  });

  it("does not trust a falsely small declared length", async () => {
    const streamed = streamedRequest(
      [new Uint8Array(MAX_MCP_REQUEST_BYTES), new Uint8Array(1)],
      "1",
    );

    const result = await prepareMcpRequest(streamed.request);

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(413);
    expect(streamed.cancelled()).toBe(1);
  });

  it("accepts exactly the limit and rebuilds the verified request", async () => {
    const streamed = streamedRequest(
      [new Uint8Array(MAX_MCP_REQUEST_BYTES)],
      "1",
    );

    const result = await prepareMcpRequest(streamed.request);

    expect(result).toBeInstanceOf(Request);
    const prepared = result as Request;
    expect(prepared.headers.get("content-length")).toBe(
      String(MAX_MCP_REQUEST_BYTES),
    );
    expect((await prepared.arrayBuffer()).byteLength).toBe(
      MAX_MCP_REQUEST_BYTES,
    );
  });

  it("bounds the number of retained stream chunks", async () => {
    const streamed = streamedRequest(
      Array.from({ length: 4097 }, () => new Uint8Array(1)),
    );

    const result = await prepareMcpRequest(streamed.request);

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(413);
    expect(streamed.pulls()).toBe(4097);
    expect(streamed.cancelled()).toBe(1);
  });

  it("preserves the largest supported model-visible image payload", async () => {
    const image = `data:image/png;base64,${"A".repeat(13_333_334)}`;
    const rawBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "attach_image_to_ticket",
        arguments: { ticketId: 1, image },
      },
    });
    const request = new Request("https://worker.example/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: rawBody,
    });

    const result = await prepareMcpRequest(request);

    expect(result).toBeInstanceOf(Request);
    expect(await (result as Request).text()).toBe(rawBody);
  });

  it("does not buffer non-POST requests", async () => {
    const request = new Request("https://worker.example/mcp");
    expect(await prepareMcpRequest(request)).toBe(request);
  });
});
