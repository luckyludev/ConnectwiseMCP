import {
  createRemoteJWKSet,
  customFetch,
  jwtVerify,
  type FetchImplementation,
  type JWTVerifyGetKey,
  type RemoteJWKSet,
} from "jose";
import type { EntraIdentityClaims } from "./auth-policy";

const ENTRA_MAX_TOKEN_AGE_SECONDS = 7_200;
const MAX_ENTRA_JWKS_RESPONSE_BYTES = 65_536;
const MAX_ENTRA_JWKS_RESPONSE_CHUNKS = 1_024;

export type EntraJwtConfig = {
  issuer: string;
  audience: string;
  tenantId: string;
};

async function cancelBody(
  body: ReadableStream<Uint8Array> | null,
): Promise<void> {
  try {
    await body?.cancel();
  } catch {
    // The stream may already be errored; rejection remains fail-closed.
  }
}

async function boundJwksResponse(response: Response): Promise<Response> {
  if (response.status !== 200) {
    await cancelBody(response.body);
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  const declaredLength = response.headers.get("Content-Length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > MAX_ENTRA_JWKS_RESPONSE_BYTES
    ) {
      await cancelBody(response.body);
      throw new Error("invalid_entra_jwks_response");
    }
  }

  if (!response.body) throw new Error("invalid_entra_jwks_response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let chunkCount = 0;
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunkCount += 1;
      if (
        chunkCount > MAX_ENTRA_JWKS_RESPONSE_CHUNKS ||
        total + value.byteLength > MAX_ENTRA_JWKS_RESPONSE_BYTES
      ) {
        throw new Error("invalid_entra_jwks_response");
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // The stream may already be errored; retain the original failure.
    }
    throw error;
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(bytes, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export function createEntraJwks(
  tenantId: string,
  fetcher: FetchImplementation = (url, options) => fetch(url, options),
): RemoteJWKSet {
  const jwksUrl = new URL(
    `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/discovery/v2.0/keys`,
  );
  return createRemoteJWKSet(jwksUrl, {
    cooldownDuration: 30_000,
    cacheMaxAge: 3_600_000,
    timeoutDuration: 5_000,
    [customFetch]: async (url, options) =>
      boundJwksResponse(await fetcher(url, options)),
  });
}

export async function verifyEntraAccessToken(
  token: string,
  config: EntraJwtConfig,
  getKey: JWTVerifyGetKey,
  options: { expectedNonce?: string } = {},
): Promise<EntraIdentityClaims> {
  const { payload } = await jwtVerify(token, getKey, {
    algorithms: ["RS256"],
    issuer: config.issuer,
    audience: config.audience,
    typ: "JWT",
    requiredClaims: ["exp", "iat", "nbf", "tid", "oid"],
    clockTolerance: 5,
    maxTokenAge: ENTRA_MAX_TOKEN_AGE_SECONDS,
  });

  if (payload.tid !== config.tenantId) {
    throw new Error("invalid_tenant");
  }
  if (typeof payload.oid !== "string" || payload.oid.length === 0) {
    throw new Error("missing_object_id");
  }
  if (
    options.expectedNonce !== undefined &&
    payload.nonce !== options.expectedNonce
  ) {
    throw new Error("invalid_oidc_nonce");
  }

  return {
    tid: payload.tid,
    oid: payload.oid,
    groups: payload.groups,
    roles: payload.roles,
    hasgroups: payload.hasgroups,
    _claim_names: payload._claim_names,
  };
}
