import { describe, expect, it } from "vitest";
import {
  buildEntraAuthorizationUrl,
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
    const fetcher: typeof fetch = async (input, init) => {
      capturedUrl = String(input);
      capturedBody = String(init?.body);
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
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code_verifier")).toBe("required-verifier");
    expect(body.get("redirect_uri")).toBe("https://mcp.example.com/callback");
    expect(result).toMatchObject({
      idToken: "signed-id-token",
      refreshToken: "rotating-refresh-token",
      expiresIn: 3600,
    });
  });
});

describe("refreshEntraTokens", () => {
  it("uses the current upstream refresh token and requires a rotated replacement", async () => {
    let capturedBody = "";
    const fetcher: typeof fetch = async (_input, init) => {
      capturedBody = String(init?.body);
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
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("current-refresh-token");
    expect(result.refreshToken).toBe("replacement-refresh-token");
  });
});
