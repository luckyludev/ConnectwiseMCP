import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWTVerifyGetKey,
} from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { verifyEntraAccessToken } from "../src/entra-jwt";

const now = Math.floor(Date.now() / 1000);
const issuer = "https://login.microsoftonline.com/tenant-a/v2.0";
const audience = "api://connectwise-mcp";
let privateKey: CryptoKey;
let getKey: JWTVerifyGetKey;

beforeAll(async () => {
  const keys = await generateKeyPair("RS256", { extractable: true });
  privateKey = keys.privateKey;
  const publicJwk = await exportJWK(keys.publicKey);
  publicJwk.kid = "test-key";
  publicJwk.alg = "RS256";
  getKey = createLocalJWKSet({ keys: [publicJwk] });
});

async function token(
  overrides: {
    issuer?: string;
    audience?: string;
    tenantId?: string;
    objectId?: string;
    expiresAt?: number;
    notBefore?: number;
    issuedAt?: number;
    nonce?: string;
  } = {},
) {
  return new SignJWT({
    tid: overrides.tenantId ?? "tenant-a",
    oid: overrides.objectId ?? "user-1",
    groups: ["group-mcp-users"],
    nonce: overrides.nonce,
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-key", typ: "JWT" })
    .setIssuer(overrides.issuer ?? issuer)
    .setAudience(overrides.audience ?? audience)
    .setIssuedAt(overrides.issuedAt ?? now - 30)
    .setNotBefore(overrides.notBefore ?? now - 30)
    .setExpirationTime(overrides.expiresAt ?? now + 300)
    .sign(privateKey);
}

const config = {
  issuer,
  audience,
  tenantId: "tenant-a",
};

describe("verifyEntraAccessToken", () => {
  it("accepts only a current RS256 token for the configured issuer, audience, tenant, and immutable identity", async () => {
    await expect(
      verifyEntraAccessToken(await token(), config, getKey),
    ).resolves.toMatchObject({ tid: "tenant-a", oid: "user-1" });

    await expect(
      verifyEntraAccessToken(
        await token({ expiresAt: now - 10 }),
        config,
        getKey,
      ),
    ).rejects.toThrow();

    await expect(
      verifyEntraAccessToken(
        await token({ notBefore: now + 60 }),
        config,
        getKey,
      ),
    ).rejects.toThrow();

    await expect(
      verifyEntraAccessToken(
        await token({ audience: "api://another-resource" }),
        config,
        getKey,
      ),
    ).rejects.toThrow();

    await expect(
      verifyEntraAccessToken(
        await token({ issuer: "https://issuer.example.com" }),
        config,
        getKey,
      ),
    ).rejects.toThrow();

    await expect(
      verifyEntraAccessToken(
        await token({ tenantId: "tenant-b" }),
        config,
        getKey,
      ),
    ).rejects.toThrow();

    await expect(
      verifyEntraAccessToken(await token({ objectId: "" }), config, getKey),
    ).rejects.toThrow();
  });

  it("requires the browser-bound OIDC nonce when one is expected", async () => {
    await expect(
      verifyEntraAccessToken(
        await token({ nonce: "expected-nonce" }),
        config,
        getKey,
        { expectedNonce: "expected-nonce" },
      ),
    ).resolves.toMatchObject({ tid: "tenant-a", oid: "user-1" });

    await expect(
      verifyEntraAccessToken(
        await token({ nonce: "wrong-nonce" }),
        config,
        getKey,
        { expectedNonce: "expected-nonce" },
      ),
    ).rejects.toThrow();
  });

  it("rejects tokens issued too long ago or in the future", async () => {
    await expect(
      verifyEntraAccessToken(
        await token({ issuedAt: now - 7_260 }),
        config,
        getKey,
      ),
    ).rejects.toThrow();

    await expect(
      verifyEntraAccessToken(
        await token({ issuedAt: now + 60 }),
        config,
        getKey,
      ),
    ).rejects.toThrow();
  });
});
