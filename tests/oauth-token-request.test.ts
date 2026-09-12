import { describe, expect, it } from "vitest";
import {
  MAX_OAUTH_TOKEN_REQUEST_BYTES,
  prepareOAuthTokenRequest,
} from "../src/oauth-token-request";

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
  const headers = new Headers({
    "content-type": "application/x-www-form-urlencoded",
  });
  if (contentLength !== undefined) headers.set("content-length", contentLength);
  const request = new Request("https://worker.example/oauth/token", {
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

async function expectOAuthError(
  result: Request | Response,
  status: number,
  description: string,
): Promise<void> {
  expect(result).toBeInstanceOf(Response);
  const response = result as Response;
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("pragma")).toBe("no-cache");
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(await response.json()).toEqual({
    error: "invalid_request",
    error_description: description,
  });
}

describe("prepareOAuthTokenRequest", () => {
  it("rejects a declared oversized body without consuming it", async () => {
    const request = new Request("https://worker.example/oauth/token", {
      method: "POST",
      headers: {
        "content-length": String(MAX_OAUTH_TOKEN_REQUEST_BYTES + 1),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=refresh_token",
    });

    const result = await prepareOAuthTokenRequest(request);

    await expectOAuthError(result, 413, "Request body too large");
    expect(request.bodyUsed).toBe(false);
  });

  it.each(["invalid", "+1", "-1", "1.0"])(
    "rejects malformed declared length %s",
    async (contentLength) => {
      const request = new Request("https://worker.example/oauth/token", {
        method: "POST",
        headers: {
          "content-length": contentLength,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=authorization_code",
      });

      await expectOAuthError(
        await prepareOAuthTokenRequest(request),
        400,
        "Invalid request length",
      );
      expect(request.bodyUsed).toBe(false);
    },
  );

  it("accepts a digit-only declared length with leading zeroes", async () => {
    const streamed = streamedRequest(
      [new TextEncoder().encode("token=a")],
      "00010",
    );

    const result = await prepareOAuthTokenRequest(streamed.request);

    expect(result).toBeInstanceOf(Request);
    expect(await (result as Request).text()).toBe("token=a");
  });

  it("returns provider-compatible CORS headers on a rejected request", async () => {
    const request = new Request("https://worker.example/oauth/token", {
      method: "POST",
      headers: {
        "content-length": String(MAX_OAUTH_TOKEN_REQUEST_BYTES + 1),
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://client.example",
      },
      body: "token=a",
    });

    const result = await prepareOAuthTokenRequest(request);

    await expectOAuthError(result, 413, "Request body too large");
    const response = result as Response;
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://client.example",
    );
    expect(response.headers.get("access-control-allow-methods")).toBe("*");
    expect(response.headers.get("access-control-allow-headers")).toBe(
      "Authorization, *",
    );
    expect(response.headers.get("access-control-max-age")).toBe("86400");
  });

  it("does not trust a falsely small declared length", async () => {
    const streamed = streamedRequest(
      [new Uint8Array(MAX_OAUTH_TOKEN_REQUEST_BYTES), new Uint8Array(1)],
      "1",
    );

    const result = await prepareOAuthTokenRequest(streamed.request);

    await expectOAuthError(result, 413, "Request body too large");
    expect(streamed.cancelled()).toBe(1);
  });

  it("bounds fragmented request bodies", async () => {
    const streamed = streamedRequest(
      Array.from({ length: 257 }, () => new Uint8Array(1)),
    );

    const result = await prepareOAuthTokenRequest(streamed.request);

    await expectOAuthError(result, 413, "Request body too large");
    expect(streamed.pulls()).toBe(257);
    expect(streamed.cancelled()).toBe(1);
  });

  it("returns a sanitized error when the request stream fails", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("secret stream failure"));
      },
    });
    const request = new Request("https://worker.example/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const result = await prepareOAuthTokenRequest(request);

    await expectOAuthError(result, 400, "Invalid request body");
  });

  it("accepts exactly the byte limit", async () => {
    const streamed = streamedRequest([
      new Uint8Array(MAX_OAUTH_TOKEN_REQUEST_BYTES),
    ]);

    const result = await prepareOAuthTokenRequest(streamed.request);

    expect(result).toBeInstanceOf(Request);
    const prepared = result as Request;
    expect(prepared.headers.get("content-length")).toBe(
      String(MAX_OAUTH_TOKEN_REQUEST_BYTES),
    );
    expect((await prepared.arrayBuffer()).byteLength).toBe(
      MAX_OAUTH_TOKEN_REQUEST_BYTES,
    );
  });

  it.each([
    {
      name: "public authorization-code request",
      body: "grant_type=authorization_code&code=code&code_verifier=verifier&client_id=client",
      authorization: undefined,
    },
    {
      name: "confidential Basic refresh request",
      body: "grant_type=refresh_token&refresh_token=token",
      authorization: "Basic Y2xpZW50OnNlY3JldA==",
    },
    {
      name: "client_secret_post revocation request",
      body: "token=token&client_id=client&client_secret=secret",
      authorization: undefined,
    },
  ])("preserves a valid $name", async ({ body, authorization }) => {
    const headers = new Headers({
      "content-type": "application/x-www-form-urlencoded",
    });
    if (authorization) headers.set("authorization", authorization);
    const request = new Request("https://worker.example/oauth/token", {
      method: "POST",
      headers,
      body,
    });

    const result = await prepareOAuthTokenRequest(request);

    expect(result).toBeInstanceOf(Request);
    const prepared = result as Request;
    expect(prepared.headers.get("authorization")).toBe(authorization ?? null);
    expect(await prepared.text()).toBe(body);
  });

  it("does not buffer non-POST requests", async () => {
    const request = new Request("https://worker.example/oauth/token");
    expect(await prepareOAuthTokenRequest(request)).toBe(request);
  });
});
