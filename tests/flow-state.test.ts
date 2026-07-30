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

describe("signed OAuth flow state", () => {
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
