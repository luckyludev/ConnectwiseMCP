import { describe, expect, it } from "vitest";
import {
  isConfiguredClientRedirectUri,
  MAX_CLIENT_METADATA_BYTES,
  prepareClientRegistrationRequest,
  validateClientRegistration as validateRegistration,
} from "../src/client-registration";

function validateClientRegistration(
  metadata: Record<string, unknown>,
  configuredUris: string,
) {
  return validateRegistration(
    metadata,
    configuredUris,
    new TextEncoder().encode(JSON.stringify(metadata)).byteLength,
  );
}

describe("prepareClientRegistrationRequest", () => {
  it("rejects a declared oversized body without consuming it", async () => {
    const request = new Request("https://worker.example/oauth/register", {
      method: "POST",
      headers: {
        "content-length": String(MAX_CLIENT_METADATA_BYTES + 1),
        "content-type": "application/json",
        origin: "https://client.example",
      },
      body: "{}",
    });

    const result = await prepareClientRegistrationRequest(request);

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(413);
    expect((result as Response).headers.get("cache-control")).toBe("no-store");
    expect((result as Response).headers.get("pragma")).toBe("no-cache");
    expect(
      (result as Response).headers.get("access-control-allow-origin"),
    ).toBe("https://client.example");
    expect(
      (result as Response).headers.get("access-control-allow-methods"),
    ).toBe("*");
    expect(
      (result as Response).headers.get("access-control-allow-headers"),
    ).toBe("Authorization, *");
    expect(await (result as Response).json()).toEqual({
      error: "invalid_client_metadata",
      error_description: "Client metadata is too large",
    });
    expect(request.bodyUsed).toBe(false);
  });

  it("cancels a streamed body as soon as its actual size exceeds the limit", async () => {
    let pulls = 0;
    let cancellations = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(
          new Uint8Array(pulls === 1 ? MAX_CLIENT_METADATA_BYTES : 1),
        );
      },
      cancel() {
        cancellations += 1;
      },
    });
    const request = new Request("https://worker.example/oauth/register", {
      method: "POST",
      headers: { "content-length": "1" },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const result = await prepareClientRegistrationRequest(request);

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(413);
    expect(pulls).toBe(2);
    expect(cancellations).toBe(1);
  });

  it("rebuilds an accepted request with its verified byte length", async () => {
    const rawBody = JSON.stringify({
      redirect_uris: ["https://client.example/callback"],
    });
    const request = new Request(
      "https://worker.example/oauth/register?version=1",
      {
        method: "POST",
        headers: {
          "content-length": "1",
          "content-type": "application/json",
          "x-request-marker": "kept",
        },
        body: rawBody,
      },
    );

    const result = await prepareClientRegistrationRequest(request);

    expect(result).toBeInstanceOf(Request);
    const bounded = result as Request;
    expect(bounded.url).toBe(request.url);
    expect(bounded.method).toBe("POST");
    expect(bounded.headers.get("content-type")).toBe("application/json");
    expect(bounded.headers.get("x-request-marker")).toBe("kept");
    expect(bounded.headers.get("content-length")).toBe(
      String(new TextEncoder().encode(rawBody).byteLength),
    );
    expect(await bounded.text()).toBe(rawBody);
  });

  it.each(["invalid", "01", "+1"])(
    "rejects malformed declared length %s without consuming the body",
    async (contentLength) => {
      const request = new Request("https://worker.example/oauth/register", {
        method: "POST",
        headers: { "content-length": contentLength },
        body: "{}",
      });

      const result = await prepareClientRegistrationRequest(request);

      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(400);
      expect(request.bodyUsed).toBe(false);
    },
  );
});

describe("validateClientRegistration", () => {
  it("allows only exact configured HTTPS redirect URIs", () => {
    expect(
      validateClientRegistration(
        { redirect_uris: ["https://chatgpt.com/connector/callback"] },
        JSON.stringify(["https://chatgpt.com/connector/callback"]),
      ),
    ).toBeUndefined();

    expect(
      validateClientRegistration(
        { redirect_uris: ["https://attacker.example/callback"] },
        JSON.stringify(["https://chatgpt.com/connector/callback"]),
      ),
    ).toMatchObject({ code: "invalid_redirect_uri", status: 400 });

    expect(
      validateClientRegistration(
        { redirect_uris: ["http://chatgpt.com/callback"] },
        JSON.stringify(["https://chatgpt.com/connector/callback"]),
      ),
    ).toMatchObject({ code: "invalid_redirect_uri", status: 400 });

    expect(
      validateClientRegistration(
        { redirect_uris: ["https://chatgpt.com/unapproved/callback"] },
        JSON.stringify(["https://chatgpt.com/connector/callback"]),
      ),
    ).toMatchObject({ code: "invalid_redirect_uri", status: 400 });

    expect(
      validateClientRegistration(
        { redirect_uris: ["https://chatgpt.com/connector/callback?other=1"] },
        JSON.stringify(["https://chatgpt.com/connector/callback"]),
      ),
    ).toMatchObject({ code: "invalid_redirect_uri", status: 400 });

    expect(
      validateClientRegistration(
        { redirect_uris: ["https://chatgpt.com:8443/connector/callback"] },
        JSON.stringify(["https://chatgpt.com/connector/callback"]),
      ),
    ).toMatchObject({ code: "invalid_redirect_uri", status: 400 });

    expect(
      validateClientRegistration(
        { redirect_uris: ["https://chatgpt.com:443/connector/callback"] },
        JSON.stringify(["https://chatgpt.com/connector/callback"]),
      ),
    ).toMatchObject({ code: "invalid_redirect_uri", status: 400 });

    expect(
      validateClientRegistration(
        { redirect_uris: ["https://chatgpt.com/a/../connector/callback"] },
        JSON.stringify(["https://chatgpt.com/connector/callback"]),
      ),
    ).toMatchObject({ code: "invalid_redirect_uri", status: 400 });
  });

  it("permits only loopback port variance for an exact configured callback", () => {
    expect(
      validateClientRegistration(
        { redirect_uris: ["http://127.0.0.1:49152/callback"] },
        JSON.stringify(["http://127.0.0.1/callback"]),
      ),
    ).toBeUndefined();

    expect(
      validateClientRegistration(
        { redirect_uris: ["http://127.0.0.1:49152/other"] },
        JSON.stringify(["http://127.0.0.1/callback"]),
      ),
    ).toMatchObject({ code: "invalid_redirect_uri", status: 400 });

    expect(
      validateClientRegistration(
        { redirect_uris: ["http://127.0.0.1:49152/a/../callback"] },
        JSON.stringify(["http://127.0.0.1/callback"]),
      ),
    ).toMatchObject({ code: "invalid_redirect_uri", status: 400 });

    expect(
      validateClientRegistration(
        { redirect_uris: ["http://localhost:49152/callback"] },
        JSON.stringify(["http://127.0.0.1/callback"]),
      ),
    ).toMatchObject({ code: "invalid_redirect_uri", status: 400 });

    expect(
      validateClientRegistration(
        { redirect_uris: ["http://127.0.0.2:49152/callback"] },
        JSON.stringify(["http://127.0.0.1/callback"]),
      ),
    ).toMatchObject({ code: "invalid_redirect_uri", status: 400 });
  });

  it("bounds registration metadata, redirect counts, URI lengths, and duplicates", () => {
    const approved = "https://client.example/callback";
    const configured = JSON.stringify([approved]);

    const exactMetadata = { redirect_uris: [approved], padding: "" };
    exactMetadata.padding = "x".repeat(
      16 * 1024 -
        new TextEncoder().encode(JSON.stringify(exactMetadata)).length,
    );
    expect(
      new TextEncoder().encode(JSON.stringify(exactMetadata)),
    ).toHaveLength(16 * 1024);
    expect(
      validateClientRegistration(exactMetadata, configured),
    ).toBeUndefined();
    expect(
      validateClientRegistration(
        { ...exactMetadata, padding: `${exactMetadata.padding}x` },
        configured,
      ),
    ).toMatchObject({ code: "invalid_client_metadata", status: 400 });

    const compactMetadata = JSON.stringify({ redirect_uris: [approved] });
    const paddedRawBody = `${" ".repeat(16 * 1024 + 1 - compactMetadata.length)}${compactMetadata}`;
    expect(new TextEncoder().encode(paddedRawBody).length).toBe(16 * 1024 + 1);
    expect(
      validateRegistration(
        { redirect_uris: [approved] },
        configured,
        new TextEncoder().encode(paddedRawBody).byteLength,
      ),
    ).toMatchObject({ code: "invalid_client_metadata", status: 400 });

    const tenUris = Array.from(
      { length: 10 },
      (_, index) => `https://client.example/callback/${index}`,
    );
    expect(
      validateClientRegistration(
        { redirect_uris: tenUris },
        JSON.stringify(tenUris),
      ),
    ).toBeUndefined();
    const elevenUris = [...tenUris, "https://client.example/callback/10"];
    expect(
      validateClientRegistration(
        { redirect_uris: elevenUris },
        JSON.stringify(elevenUris),
      ),
    ).toMatchObject({ code: "invalid_redirect_uri", status: 400 });

    expect(
      validateClientRegistration(
        { redirect_uris: [approved, approved] },
        configured,
      ),
    ).toMatchObject({ code: "invalid_redirect_uri", status: 400 });
    expect(
      validateClientRegistration(
        { redirect_uris: [approved] },
        JSON.stringify([approved, approved]),
      ),
    ).toMatchObject({ code: "invalid_redirect_uri", status: 400 });

    const prefix = "https://client.example/";
    const exactUri = `${prefix}${"a".repeat(2_048 - prefix.length)}`;
    expect(new TextEncoder().encode(exactUri)).toHaveLength(2_048);
    expect(
      validateClientRegistration(
        { redirect_uris: [exactUri] },
        JSON.stringify([exactUri]),
      ),
    ).toBeUndefined();
    expect(
      validateClientRegistration(
        { redirect_uris: [`${exactUri}a`] },
        JSON.stringify([`${exactUri}a`]),
      ),
    ).toMatchObject({ code: "invalid_redirect_uri", status: 400 });
  });
});

describe("isConfiguredClientRedirectUri", () => {
  it("fails closed for missing or malformed deployment allowlists", () => {
    const callback = "https://client.example.com/callback";
    for (const configured of [
      "",
      "not-json",
      "[]",
      "{}",
      '["https://client.example.com/callback",7]',
      '["https://client.example.com/callback","http://public.example/callback"]',
    ]) {
      expect(isConfiguredClientRedirectUri(callback, configured)).toBe(false);
    }
  });

  it("matches an exact HTTPS callback or approved local port variance", () => {
    expect(
      isConfiguredClientRedirectUri(
        "https://client.example.com/callback",
        '["https://client.example.com/callback"]',
      ),
    ).toBe(true);
    expect(
      isConfiguredClientRedirectUri(
        "http://127.0.0.1:49152/callback",
        '["http://127.0.0.1/callback"]',
      ),
    ).toBe(true);
  });
});
