import {
  SignJWT,
  createLocalJWKSet,
  decodeJwt,
  exportJWK,
  generateKeyPair,
} from "jose";
import { describe, expect, it } from "vitest";
import { createEntraAuthHandler, type WorkerEnv } from "../src/auth-handler";

describe("Entra auth handler", () => {
  it.each([
    undefined,
    "https://other.example.com/mcp",
    "https://mcp.example.com:443/mcp",
  ])(
    "rejects an authorization request whose resource is %s",
    async (resource) => {
      let lookedUp = false;
      const env = {
        MCP_CANONICAL_URL: "https://mcp.example.com/mcp",
        OAUTH_PROVIDER: {
          async parseAuthRequest() {
            return {
              responseType: "code",
              clientId: "mcp-client",
              redirectUri: "https://client.example.com/callback",
              scope: ["mcp:read"],
              state: "client-state",
              codeChallenge: "challenge",
              codeChallengeMethod: "S256",
              resource,
            };
          },
          async lookupClient() {
            lookedUp = true;
            return undefined;
          },
        },
      } as unknown as WorkerEnv;

      const response = await createEntraAuthHandler().fetch!(
        new Request("https://mcp.example.com/authorize") as never,
        env,
        {} as ExecutionContext,
      );

      expect(response.status).toBe(400);
      expect(await response.text()).toBe("Invalid authorization resource");
      expect(lookedUp).toBe(false);
    },
  );

  it("rejects a non-canonical configured resource before client lookup", async () => {
    let lookedUp = false;
    const env = {
      MCP_CANONICAL_URL: "https://mcp.example.com:443/mcp",
      OAUTH_PROVIDER: {
        async parseAuthRequest() {
          return {
            responseType: "code",
            clientId: "mcp-client",
            redirectUri: "https://client.example.com/callback",
            scope: ["mcp:read"],
            state: "client-state",
            codeChallenge: "challenge",
            codeChallengeMethod: "S256",
            resource: "https://mcp.example.com/mcp",
          };
        },
        async lookupClient() {
          lookedUp = true;
          return undefined;
        },
      },
    } as unknown as WorkerEnv;

    const response = await createEntraAuthHandler().fetch!(
      new Request("https://mcp.example.com/authorize") as never,
      env,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Invalid server configuration");
    expect(lookedUp).toBe(false);
  });

  it("rejects a non-canonical loopback redirect during authorization", async () => {
    const env = {
      OAUTH_STATE_SECRET: "0123456789abcdef0123456789abcdef",
      MCP_CANONICAL_URL: "https://mcp.example.com/mcp",
      OAUTH_PROVIDER: {
        async parseAuthRequest() {
          return {
            responseType: "code",
            clientId: "mcp-client",
            redirectUri: "http://127.0.0.1:49152/a/../callback",
            scope: ["mcp:read"],
            state: "client-state",
            codeChallenge: "challenge",
            codeChallengeMethod: "S256",
            resource: "https://mcp.example.com/mcp",
          };
        },
        async lookupClient() {
          return {
            clientId: "mcp-client",
            clientName: "Local MCP client",
            redirectUris: ["http://127.0.0.1/callback"],
          };
        },
      },
    } as unknown as WorkerEnv;

    const response = await createEntraAuthHandler().fetch!(
      new Request("https://mcp.example.com/authorize") as never,
      env,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Invalid client redirect URI");
  });

  it("allows a canonical loopback authorization redirect with only port variance", async () => {
    const env = {
      OAUTH_STATE_SECRET: "0123456789abcdef0123456789abcdef",
      MCP_CANONICAL_URL: "https://mcp.example.com/mcp",
      OAUTH_PROVIDER: {
        async parseAuthRequest() {
          return {
            responseType: "code",
            clientId: "mcp-client",
            redirectUri: "http://127.0.0.1:49152/callback",
            scope: ["mcp:read"],
            state: "client-state",
            codeChallenge: "challenge",
            codeChallengeMethod: "S256",
            resource: "https://mcp.example.com/mcp",
          };
        },
        async lookupClient() {
          return {
            clientId: "mcp-client",
            clientName: "Local MCP client",
            redirectUris: ["http://127.0.0.1/callback"],
          };
        },
      },
    } as unknown as WorkerEnv;

    const response = await createEntraAuthHandler().fetch!(
      new Request("https://mcp.example.com/authorize") as never,
      env,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Set-Cookie")).toContain("__Host-CW_CSRF=");
  });

  it("renders consent only after provider client validation and sets a secure CSRF cookie", async () => {
    let parsed = false;
    const env = {
      OAUTH_STATE_SECRET: "0123456789abcdef0123456789abcdef",
      ENTRA_TENANT_ID: "tenant-a",
      ENTRA_CLIENT_ID: "entra-client",
      ENTRA_CLIENT_SECRET: "secret",
      MCP_CANONICAL_URL: "https://mcp.example.com/mcp",
      IDENTITY_PROFILE_MAP: "{}",
      ALLOWED_GROUP_IDS: "[]",
      ALLOWED_APP_ROLES: "[]",
      OAUTH_PROVIDER: {
        async parseAuthRequest() {
          parsed = true;
          return {
            responseType: "code",
            clientId: "mcp-client",
            redirectUri: "https://client.example.com/callback",
            scope: ["mcp:read"],
            state: "client-state",
            codeChallenge: "challenge",
            codeChallengeMethod: "S256",
            resource: "https://mcp.example.com/mcp",
          };
        },
        async lookupClient() {
          return {
            clientId: "mcp-client",
            clientName: "Trusted MCP Client",
            redirectUris: ["https://client.example.com/callback"],
          };
        },
      },
    } as unknown as WorkerEnv;

    const handler = createEntraAuthHandler();
    const response = await handler.fetch!(
      new Request("https://mcp.example.com/authorize") as never,
      env,
      {} as ExecutionContext,
    );

    expect(parsed).toBe(true);
    expect(response.status).toBe(200);
    expect(response.headers.get("Set-Cookie")).toContain("__Host-CW_CSRF=");
    expect(response.headers.get("Set-Cookie")).toContain("HttpOnly");
    expect(response.headers.get("Set-Cookie")).toContain("Secure");
  });

  it("starts Entra login only after CSRF validation and binds callback state to the browser", async () => {
    const oauthRequest = {
      responseType: "code",
      clientId: "mcp-client",
      redirectUri: "https://client.example.com/callback",
      scope: ["mcp:read"],
      state: "client-state",
      codeChallenge: "challenge",
      codeChallengeMethod: "S256",
      resource: "https://mcp.example.com/mcp",
    };
    const env = {
      OAUTH_STATE_SECRET: "0123456789abcdef0123456789abcdef",
      ENTRA_TENANT_ID: "tenant-a",
      ENTRA_CLIENT_ID: "entra-client",
      ENTRA_CLIENT_SECRET: "secret",
      MCP_CANONICAL_URL: "https://mcp.example.com/mcp",
      IDENTITY_PROFILE_MAP: "{}",
      ALLOWED_GROUP_IDS: "[]",
      ALLOWED_APP_ROLES: "[]",
      OAUTH_PROVIDER: {
        async parseAuthRequest() {
          return oauthRequest;
        },
        async lookupClient() {
          return {
            clientId: "mcp-client",
            clientName: "Trusted MCP Client",
            redirectUris: ["https://client.example.com/callback"],
          };
        },
      },
    } as unknown as WorkerEnv;
    const handler = createEntraAuthHandler();
    const consent = await handler.fetch!(
      new Request("https://mcp.example.com/authorize") as never,
      env,
      {} as ExecutionContext,
    );
    const html = await consent.text();
    const flowState = html.match(/name="flow_state" value="([^"]+)"/)?.[1];
    const csrfToken = consent.headers
      .get("Set-Cookie")
      ?.match(/__Host-CW_CSRF=([^;]+)/)?.[1];
    expect(flowState).toBeTruthy();
    expect(csrfToken).toBeTruthy();

    const response = await handler.fetch!(
      new Request("https://mcp.example.com/authorize", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `__Host-CW_CSRF=${csrfToken}`,
        },
        body: new URLSearchParams({
          flow_state: flowState!,
          csrf_token: csrfToken!,
        }),
      }) as never,
      env,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location")!);
    expect(location.origin).toBe("https://login.microsoftonline.com");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("state")).toBeTruthy();
    expect(response.headers.get("Set-Cookie")).toContain(
      "__Host-CW_ENTRA_STATE=",
    );
  });

  it("validates the Entra callback and completes authorization with an immutable profile", async () => {
    const now = Math.floor(Date.now() / 1000);
    const keys = await generateKeyPair("RS256", { extractable: true });
    const jwk = await exportJWK(keys.publicKey);
    jwk.kid = "entra-test-key";
    jwk.alg = "RS256";
    const getKey = createLocalJWKSet({ keys: [jwk] });
    let completed: Record<string, unknown> | undefined;
    let tokenRequestBody = "";
    let idToken = "";
    const fetcher: typeof fetch = async (_input, init) => {
      tokenRequestBody = String(init?.body);
      return Response.json({
        id_token: idToken,
        refresh_token: "rotated-upstream-refresh-token",
        expires_in: 3600,
      });
    };
    const oauthRequest = {
      responseType: "code",
      clientId: "mcp-client",
      redirectUri: "https://client.example.com/callback",
      scope: ["mcp:read"],
      state: "client-state",
      codeChallenge: "challenge",
      codeChallengeMethod: "S256",
      resource: "https://mcp.example.com/mcp",
    };
    const env = {
      OAUTH_STATE_SECRET: "0123456789abcdef0123456789abcdef",
      ENTRA_TENANT_ID: "tenant-a",
      ENTRA_CLIENT_ID: "entra-client",
      ENTRA_CLIENT_SECRET: "secret",
      MCP_CANONICAL_URL: "https://mcp.example.com/mcp",
      IDENTITY_PROFILE_MAP: JSON.stringify({ "tenant-a:user-1": "LUIS" }),
      ALLOWED_GROUP_IDS: JSON.stringify(["group-mcp-users"]),
      ALLOWED_APP_ROLES: "[]",
      OAUTH_PROVIDER: {
        async parseAuthRequest() {
          return oauthRequest;
        },
        async lookupClient() {
          return {
            clientId: "mcp-client",
            clientName: "Trusted MCP Client",
            redirectUris: ["https://client.example.com/callback"],
          };
        },
        async completeAuthorization(options: Record<string, unknown>) {
          completed = options;
          return {
            redirectTo: "https://client.example.com/callback?code=mcp-code",
          };
        },
      },
    } as unknown as WorkerEnv;
    const handler = createEntraAuthHandler({ fetcher, getKey });

    const consent = await handler.fetch!(
      new Request("https://mcp.example.com/authorize") as never,
      env,
      {} as ExecutionContext,
    );
    const html = await consent.text();
    const flowState = html.match(/name="flow_state" value="([^"]+)"/)?.[1];
    const csrf = consent.headers
      .get("Set-Cookie")
      ?.match(/__Host-CW_CSRF=([^;]+)/)?.[1];
    const upstream = await handler.fetch!(
      new Request("https://mcp.example.com/authorize", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `__Host-CW_CSRF=${csrf}`,
        },
        body: new URLSearchParams({
          flow_state: flowState!,
          csrf_token: csrf!,
        }),
      }) as never,
      env,
      {} as ExecutionContext,
    );
    const entraLocation = new URL(upstream.headers.get("Location")!);
    const signedState = entraLocation.searchParams.get("state")!;
    const oidcNonce = decodeJwt(signedState).oidcNonce as string;
    const browserNonce = upstream.headers
      .get("Set-Cookie")
      ?.match(/__Host-CW_ENTRA_STATE=([^;]+)/)?.[1];
    idToken = await new SignJWT({
      tid: "tenant-a",
      oid: "user-1",
      groups: ["group-mcp-users"],
      nonce: oidcNonce,
    })
      .setProtectedHeader({ alg: "RS256", kid: "entra-test-key", typ: "JWT" })
      .setIssuer("https://login.microsoftonline.com/tenant-a/v2.0")
      .setAudience("entra-client")
      .setIssuedAt(now)
      .setNotBefore(now - 5)
      .setExpirationTime(now + 300)
      .sign(keys.privateKey);

    const callback = await handler.fetch!(
      new Request(
        `https://mcp.example.com/callback?code=entra-code&state=${encodeURIComponent(signedState)}`,
        { headers: { Cookie: `__Host-CW_ENTRA_STATE=${browserNonce}` } },
      ) as never,
      env,
      {} as ExecutionContext,
    );

    expect(callback.status).toBe(302);
    expect(callback.headers.get("Location")).toContain("code=mcp-code");
    expect(
      new URLSearchParams(tokenRequestBody).get("code_verifier"),
    ).toBeTruthy();
    expect(completed?.userId).toBe("tenant-a:user-1");
    expect(completed?.props).toMatchObject({
      tenantId: "tenant-a",
      objectId: "user-1",
      profileAlias: "LUIS",
    });
  });
});
