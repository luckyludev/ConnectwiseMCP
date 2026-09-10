import { describe, expect, it, vi } from "vitest";
import {
  buildEntraAuthorizationUrl,
  EntraOAuthError,
  exchangeEntraAuthorizationCode,
  refreshEntraTokens,
} from "../src/entra-oauth";

describe("buildEntraAuthorizationUrl", () => {
  it("builds a tenant-bound OIDC authorization-code request with S256 PKCE and offline access", () => {
    const url = buildEntraAuthorizationUrl(
      {
        tenantId: "tenant-a",
        clientId: "entra-client",
        clientSecret: "not-used-by-authorization-url",
        callbackUrl: "https://mcp.example.com/callback",
      },
      {
        state: "signed-state",
        codeChallenge: "pkce-challenge",
        nonce: "oidc-nonce",
      },
    );

    expect(url.origin + url.pathname).toBe(
      "https://login.microsoftonline.com/tenant-a/oauth2/v2.0/authorize",
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("response_mode")).toBe("query");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe("pkce-challenge");
    expect(url.searchParams.get("nonce")).toBe("oidc-nonce");
    expect(url.searchParams.get("state")).toBe("signed-state");
    expect(url.searchParams.get("scope")?.split(" ")).toEqual(
      expect.arrayContaining(["openid", "profile", "offline_access"]),
    );
  });
});

describe("exchangeEntraAuthorizationCode", () => {
  it("sends the upstream PKCE verifier and requires ID and refresh tokens", async () => {
    let capturedUrl = "";
    let capturedBody = "";
    let capturedRedirect: RequestRedirect | undefined;
    let capturedSignal: AbortSignal | null | undefined;
    const fetcher: typeof fetch = async (input, init) => {
      capturedUrl = String(input);
      capturedBody = String(init?.body);
      capturedRedirect = init?.redirect;
      capturedSignal = init?.signal;
      return Response.json({
        token_type: "Bearer",
        id_token: "signed-id-token",
        access_token: "unused-access-token",
        refresh_token: "rotating-refresh-token",
        expires_in: 3600,
      });
    };

    const result = await exchangeEntraAuthorizationCode(
      {
        tenantId: "tenant-a",
        clientId: "entra-client",
        clientSecret: "entra-secret",
        callbackUrl: "https://mcp.example.com/callback",
      },
      { code: "authorization-code", codeVerifier: "required-verifier" },
      fetcher,
    );

    const body = new URLSearchParams(capturedBody);
    expect(capturedUrl).toBe(
      "https://login.microsoftonline.com/tenant-a/oauth2/v2.0/token",
    );
    expect(capturedRedirect).toBe("manual");
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal?.aborted).toBe(false);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code_verifier")).toBe("required-verifier");
    expect(body.get("redirect_uri")).toBe("https://mcp.example.com/callback");
    expect(result).toMatchObject({
      idToken: "signed-id-token",
      refreshToken: "rotating-refresh-token",
      expiresIn: 3600,
    });
  });
  it("aborts a stalled token request after the bounded timeout", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((ms) => {
        setTimeout(
          () => controller.abort(new DOMException("timed out", "TimeoutError")),
          ms,
        );
        return controller.signal;
      });
    try {
      const fetcher: typeof fetch = async (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        });
      const request = exchangeEntraAuthorizationCode(
        {
          tenantId: "tenant-a",
          clientId: "entra-client",
          clientSecret: "entra-secret",
          callbackUrl: "https://mcp.example.com/callback",
        },
        { code: "authorization-code", codeVerifier: "required-verifier" },
        fetcher,
      );
      const rejection = expect(request).rejects.toMatchObject({
        name: "TimeoutError",
      });

      await vi.advanceTimersByTimeAsync(14_999);
      expect(timeout).toHaveBeenCalledWith(15_000);
      expect(controller.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await rejection;
    } finally {
      timeout.mockRestore();
      vi.useRealTimers();
    }
  });

  it("refuses token endpoint redirects without replaying credentials", async () => {
    let calls = 0;
    const fetcher: typeof fetch = async (_input, init) => {
      calls += 1;
      expect(init?.redirect).toBe("manual");
      return new Response(null, {
        status: 307,
        headers: { Location: "https://attacker.example/token" },
      });
    };

    await expect(
      exchangeEntraAuthorizationCode(
        {
          tenantId: "tenant-a",
          clientId: "entra-client",
          clientSecret: "entra-secret",
          callbackUrl: "https://mcp.example.com/callback",
        },
        { code: "authorization-code", codeVerifier: "required-verifier" },
        fetcher,
      ),
    ).rejects.toMatchObject({
      name: "EntraOAuthError",
      status: 307,
    } satisfies Partial<EntraOAuthError>);
    expect(calls).toBe(1);
  });

  it("rejects token responses with an oversized declared length and cancels the body", async () => {
    let cancelled = false;
    const fetcher: typeof fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{}"));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "Content-Length": "65537" } },
      );

    await expect(
      exchangeEntraAuthorizationCode(
        {
          tenantId: "tenant-a",
          clientId: "entra-client",
          clientSecret: "entra-secret",
          callbackUrl: "https://mcp.example.com/callback",
        },
        { code: "authorization-code", codeVerifier: "required-verifier" },
        fetcher,
      ),
    ).rejects.toThrow("invalid_entra_token_response");
    expect(cancelled).toBe(true);
  });

  it("rejects a streamed token response that exceeds the byte limit", async () => {
    const fetcher: typeof fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(65_537));
            controller.close();
          },
        }),
      );

    await expect(
      exchangeEntraAuthorizationCode(
        {
          tenantId: "tenant-a",
          clientId: "entra-client",
          clientSecret: "entra-secret",
          callbackUrl: "https://mcp.example.com/callback",
        },
        { code: "authorization-code", codeVerifier: "required-verifier" },
        fetcher,
      ),
    ).rejects.toThrow("invalid_entra_token_response");
  });

  it("preserves an HTTP error while bounding its response body", async () => {
    const fetcher: typeof fetch = async () =>
      new Response(new Uint8Array(65_537), { status: 400 });

    await expect(
      exchangeEntraAuthorizationCode(
        {
          tenantId: "tenant-a",
          clientId: "entra-client",
          clientSecret: "entra-secret",
          callbackUrl: "https://mcp.example.com/callback",
        },
        { code: "authorization-code", codeVerifier: "required-verifier" },
        fetcher,
      ),
    ).rejects.toMatchObject({
      name: "EntraOAuthError",
      status: 400,
      code: undefined,
    } satisfies Partial<EntraOAuthError>);
  });
});

describe("refreshEntraTokens", () => {
  it("uses the current upstream refresh token and requires a rotated replacement", async () => {
    let capturedBody = "";
    let capturedRedirect: RequestRedirect | undefined;
    let capturedSignal: AbortSignal | null | undefined;
    const fetcher: typeof fetch = async (_input, init) => {
      capturedBody = String(init?.body);
      capturedRedirect = init?.redirect;
      capturedSignal = init?.signal;
      return Response.json({
        id_token: "fresh-id-token",
        refresh_token: "replacement-refresh-token",
        expires_in: 3600,
      });
    };

    const result = await refreshEntraTokens(
      {
        tenantId: "tenant-a",
        clientId: "entra-client",
        clientSecret: "entra-secret",
        callbackUrl: "https://mcp.example.com/callback",
      },
      "current-refresh-token",
      fetcher,
    );

    const body = new URLSearchParams(capturedBody);
    expect(capturedRedirect).toBe("manual");
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal?.aborted).toBe(false);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("current-refresh-token");
    expect(result.refreshToken).toBe("replacement-refresh-token");
  });
});
