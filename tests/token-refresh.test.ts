import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import {
  createTokenExchangeCallback,
  type EntraGrantProps,
  type WorkerEnv,
} from "../src/auth-handler";

describe("Entra token refresh reauthorization", () => {
  it("separates grant secrets from authorization-code access-token props", async () => {
    const props: EntraGrantProps = {
      tenantId: "tenant-a",
      objectId: "user-1",
      profileAlias: "LUIS",
      groups: ["group-mcp-users"],
      roles: [],
      upstreamRefreshToken: "current-refresh-token",
      upstreamExpiresIn: 3600,
    };

    const result = await createTokenExchangeCallback({} as WorkerEnv)({
      grantType: "authorization_code" as never,
      clientId: "mcp-client",
      userId: "tenant-a:user-1",
      grantId: "grant-1",
      scope: ["mcp:read"],
      requestedScope: ["mcp:read"],
      props,
    });

    expect(result?.newProps).toBe(props);
    expect(result?.accessTokenProps).toEqual({
      tenantId: "tenant-a",
      objectId: "user-1",
      profileAlias: "LUIS",
      groups: ["group-mcp-users"],
      roles: [],
      scopes: ["mcp:read"],
    });
  });

  it("rotates the upstream refresh token and rechecks the immutable profile", async () => {
    const now = Math.floor(Date.now() / 1000);
    const keys = await generateKeyPair("RS256", { extractable: true });
    const jwk = await exportJWK(keys.publicKey);
    jwk.kid = "refresh-test-key";
    jwk.alg = "RS256";
    const getKey = createLocalJWKSet({ keys: [jwk] });
    const idToken = await new SignJWT({
      tid: "tenant-a",
      oid: "user-1",
      groups: ["group-mcp-users"],
    })
      .setProtectedHeader({ alg: "RS256", kid: "refresh-test-key", typ: "JWT" })
      .setIssuer("https://login.microsoftonline.com/tenant-a/v2.0")
      .setAudience("entra-client")
      .setIssuedAt(now)
      .setNotBefore(now - 5)
      .setExpirationTime(now + 300)
      .sign(keys.privateKey);
    let refreshRequest = "";
    const fetcher: typeof fetch = async (_input, init) => {
      refreshRequest = String(init?.body);
      return Response.json({
        id_token: idToken,
        refresh_token: "replacement-refresh-token",
        expires_in: 3600,
      });
    };
    const env = {
      ENTRA_TENANT_ID: "tenant-a",
      ENTRA_CLIENT_ID: "entra-client",
      ENTRA_CLIENT_SECRET: "secret",
      MCP_CANONICAL_URL: "https://mcp.example.com/mcp",
      IDENTITY_PROFILE_MAP: JSON.stringify({ "tenant-a:user-1": "LUIS" }),
      ALLOWED_GROUP_IDS: JSON.stringify(["group-mcp-users"]),
      ALLOWED_APP_ROLES: "[]",
    } as unknown as WorkerEnv;
    const props: EntraGrantProps = {
      tenantId: "tenant-a",
      objectId: "user-1",
      profileAlias: "LUIS",
      groups: ["group-mcp-users"],
      roles: [],
      upstreamRefreshToken: "current-refresh-token",
      upstreamExpiresIn: 3600,
    };

    const result = await createTokenExchangeCallback(env, {
      fetcher,
      getKey,
    })({
      grantType: "refresh_token" as never,
      clientId: "mcp-client",
      userId: "tenant-a:user-1",
      grantId: "grant-1",
      scope: ["mcp:read"],
      requestedScope: ["mcp:read"],
      props,
    });

    expect(new URLSearchParams(refreshRequest).get("refresh_token")).toBe(
      "current-refresh-token",
    );
    expect(result).toMatchObject({
      accessTokenTTL: 3600,
      newProps: {
        tenantId: "tenant-a",
        objectId: "user-1",
        profileAlias: "LUIS",
        upstreamRefreshToken: "replacement-refresh-token",
      },
    });
    expect(result).toMatchObject({
      accessTokenProps: {
        tenantId: "tenant-a",
        objectId: "user-1",
        profileAlias: "LUIS",
        groups: ["group-mcp-users"],
        roles: [],
        scopes: ["mcp:read"],
      },
    });
    expect(Object.keys(result!.accessTokenProps as object).sort()).toEqual([
      "groups",
      "objectId",
      "profileAlias",
      "roles",
      "scopes",
      "tenantId",
    ]);
  });

  it("does not revoke the grant for a transient upstream failure", async () => {
    let revoked = false;
    const env = {
      ENTRA_TENANT_ID: "tenant-a",
      ENTRA_CLIENT_ID: "entra-client",
      ENTRA_CLIENT_SECRET: "secret",
      MCP_CANONICAL_URL: "https://mcp.example.com/mcp",
      OAUTH_PROVIDER: {
        async revokeGrant() {
          revoked = true;
        },
      },
    } as unknown as WorkerEnv;

    await expect(
      createTokenExchangeCallback(env, {
        fetcher: async () => {
          throw new TypeError("network unavailable");
        },
      })({
        grantType: "refresh_token" as never,
        clientId: "mcp-client",
        userId: "tenant-a:user-1",
        grantId: "grant-1",
        scope: ["mcp:read"],
        requestedScope: ["mcp:read"],
        props: {
          tenantId: "tenant-a",
          objectId: "user-1",
          profileAlias: "LUIS",
          groups: [],
          roles: [],
          upstreamRefreshToken: "current-refresh-token",
          upstreamExpiresIn: 3600,
        },
      }),
    ).rejects.toThrow("network unavailable");
    expect(revoked).toBe(false);
  });

  it("revokes the grant for a terminal invalid_grant response", async () => {
    let revokedWith: unknown[] | undefined;
    const env = {
      ENTRA_TENANT_ID: "tenant-a",
      ENTRA_CLIENT_ID: "entra-client",
      ENTRA_CLIENT_SECRET: "secret",
      MCP_CANONICAL_URL: "https://mcp.example.com/mcp",
      OAUTH_PROVIDER: {
        async revokeGrant(...args: unknown[]) {
          revokedWith = args;
        },
      },
    } as unknown as WorkerEnv;

    await expect(
      createTokenExchangeCallback(env, {
        fetcher: async () =>
          Response.json(
            { error: "invalid_grant", error_description: "expired" },
            { status: 400 },
          ),
      })({
        grantType: "refresh_token" as never,
        clientId: "mcp-client",
        userId: "tenant-a:user-1",
        grantId: "grant-1",
        scope: ["mcp:read"],
        requestedScope: ["mcp:read"],
        props: {
          tenantId: "tenant-a",
          objectId: "user-1",
          profileAlias: "LUIS",
          groups: [],
          roles: [],
          upstreamRefreshToken: "current-refresh-token",
          upstreamExpiresIn: 3600,
        },
      }),
    ).rejects.toThrow();
    expect(revokedWith).toEqual(["grant-1", "tenant-a:user-1"]);
  });
});
