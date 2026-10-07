import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWTVerifyGetKey,
} from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createEntraJwks, verifyEntraAccessToken } from "../src/entra-jwt";

const now = Math.floor(Date.now() / 1000);
const issuer = "https://login.microsoftonline.com/tenant-a/v2.0";
const audience = "api://connectwise-mcp";
let privateKey: CryptoKey;
let publicJwk: Awaited<ReturnType<typeof exportJWK>>;
let getKey: JWTVerifyGetKey;

beforeAll(async () => {
  const keys = await generateKeyPair("RS256", { extractable: true });
  privateKey = keys.privateKey;
  publicJwk = await exportJWK(keys.publicKey);
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

describe("createEntraJwks", () => {
  it("accepts a bounded JWKS while preserving jose request controls", async () => {
    const fetcher = vi.fn(async (url: string, options: RequestInit) => {
      expect(url).toBe(
        "https://login.microsoftonline.com/tenant-a/discovery/v2.0/keys",
      );
      expect(options).toMatchObject({ method: "GET", redirect: "manual" });
      expect(options.signal).toBeInstanceOf(AbortSignal);
      expect(options.headers).toBeInstanceOf(Headers);
      return Response.json({ keys: [publicJwk] });
    });
    const jwks = createEntraJwks("tenant-a", fetcher);

    await expect(jwks.reload()).resolves.toBeUndefined();
    expect(jwks.jwks()).toEqual({ keys: [publicJwk] });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("cancels non-200 bodies and preserves jose status rejection", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(65_537));
      },
      cancel() {
        cancelled = true;
      },
    });
    const jwks = createEntraJwks("tenant-a", async () =>
      Promise.resolve(new Response(body, { status: 503 })),
    );

    await expect(jwks.reload()).rejects.toThrow(
      "Expected 200 OK from the JSON Web Key Set HTTP response",
    );
    expect(cancelled).toBe(true);
  });

  it("rejects and cancels a JWKS body with an oversized declared length", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([123]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const jwks = createEntraJwks("tenant-a", async () =>
      Promise.resolve(
        new Response(body, {
          headers: { "Content-Length": "65537" },
        }),
      ),
    );

    await expect(jwks.reload()).rejects.toThrow("invalid_entra_jwks_response");
    expect(cancelled).toBe(true);
  });

  it("rejects and cancels a streamed JWKS body that exceeds the byte cap", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(65_537));
      },
      cancel() {
        cancelled = true;
      },
    });
    const jwks = createEntraJwks("tenant-a", async () =>
      Promise.resolve(new Response(body)),
    );

    await expect(jwks.reload()).rejects.toThrow("invalid_entra_jwks_response");
    expect(cancelled).toBe(true);
  });

  it("rejects and cancels a pathological JWKS stream with too many chunks", async () => {
    let chunks = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunks += 1;
        controller.enqueue(new Uint8Array([32]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const jwks = createEntraJwks("tenant-a", async () =>
      Promise.resolve(new Response(body)),
    );

    await expect(jwks.reload()).rejects.toThrow("invalid_entra_jwks_response");
    expect(chunks).toBeGreaterThan(1_024);
    expect(cancelled).toBe(true);
  });
});

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
