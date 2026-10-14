import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { signFlowState, verifyFlowState } from "../src/flow-state";

const secret = "0123456789abcdef0123456789abcdef";
const origin = "https://mcp.example.com";
const request = {
  responseType: "code",
  clientId: "client-1",
  redirectUri: "https://client.example.com/callback",
  scope: ["mcp:read"],
  state: "client-state",
  codeChallenge: "challenge",
  codeChallengeMethod: "S256",
  resource: "https://mcp.example.com/mcp",
};

describe("encrypted OAuth flow state", () => {
  it("accepts an untampered unexpired state for the bound callback and purpose", async () => {
    const token = await signFlowState(
      {
        purpose: "entra_callback",
        oauthRequest: request,
        browserNonce: "browser-1",
        pkceVerifier: "verifier",
        oidcNonce: "oidc-nonce",
      },
      secret,
      origin,
      1_000,
    );

    await expect(
      verifyFlowState(token, "entra_callback", secret, origin, 1_100),
    ).resolves.toMatchObject({
      browserNonce: "browser-1",
      pkceVerifier: "verifier",
      oidcNonce: "oidc-nonce",
    });
  });

  it("keeps browser binding and PKCE values confidential", async () => {
    const browserNonce = "browser-binding-must-stay-private";
    const pkceVerifier = "pkce-verifier-must-stay-private";
    const token = await signFlowState(
      {
        purpose: "entra_callback",
        oauthRequest: request,
        browserNonce,
        pkceVerifier,
        oidcNonce: "oidc-nonce-must-stay-private",
      },
      secret,
      origin,
      1_000,
    );

    const segments = token.split(".");
    expect(segments).toHaveLength(5);
    expect(
      JSON.parse(Buffer.from(segments[0], "base64url").toString("utf8")),
    ).toEqual({
      alg: "dir",
      enc: "A256GCM",
      typ: "JWT",
    });
    for (const segment of segments) {
      const decoded = Buffer.from(segment, "base64url").toString("utf8");
      expect(decoded).not.toContain(browserNonce);
      expect(decoded).not.toContain(pkceVerifier);
      expect(decoded).not.toContain("oidc-nonce-must-stay-private");
    }
  });

  it("rejects a different secret and the former readable JWS format", async () => {
    const token = await signFlowState(
      {
        purpose: "consent",
        oauthRequest: request,
        browserNonce: "browser-1",
      },
      secret,
      origin,
      1_000,
    );
    await expect(
      verifyFlowState(
        token,
        "consent",
        "fedcba9876543210fedcba9876543210",
        origin,
        1_100,
      ),
    ).rejects.toThrow();

    const legacy = await new SignJWT({
      oauthRequest: request,
      browserNonce: "browser-1",
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(origin)
      .setAudience(`${origin}/callback`)
      .setSubject("consent")
      .setJti("browser-1")
      .setIssuedAt(1_000)
      .setExpirationTime(1_600)
      .sign(new TextEncoder().encode(secret));
    await expect(
      verifyFlowState(legacy, "consent", secret, origin, 1_100),
    ).rejects.toThrow();
  });

  it("rejects tampering, expiration, and purpose confusion", async () => {
    const token = await signFlowState(
      {
        purpose: "entra_callback",
        oauthRequest: request,
        browserNonce: "browser-1",
        pkceVerifier: "verifier",
        oidcNonce: "oidc-nonce",
      },
      secret,
      origin,
      1_000,
    );

    await expect(
      verifyFlowState(`${token}x`, "entra_callback", secret, origin, 1_100),
    ).rejects.toThrow();
    await expect(
      verifyFlowState(token, "entra_callback", secret, origin, 1_601),
    ).rejects.toThrow();
    await expect(
      verifyFlowState(token, "consent", secret, origin, 1_100),
    ).rejects.toThrow();
  });
});
