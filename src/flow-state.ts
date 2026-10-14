import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { EncryptJWT, jwtDecrypt } from "jose";

export type FlowPurpose = "consent" | "entra_callback";

export type FlowState = {
  purpose: FlowPurpose;
  oauthRequest: AuthRequest;
  browserNonce: string;
  pkceVerifier?: string;
  oidcNonce?: string;
};

const encoder = new TextEncoder();
const STATE_TTL_SECONDS = 600;

async function key(secret: string): Promise<Uint8Array> {
  const encoded = encoder.encode(secret);
  if (encoded.byteLength < 32) {
    throw new Error("OAUTH_STATE_SECRET must be at least 32 bytes");
  }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoded));
}

export async function signFlowState(
  state: FlowState,
  secret: string,
  origin: string,
  now = Math.floor(Date.now() / 1000),
): Promise<string> {
  return new EncryptJWT({
    oauthRequest: state.oauthRequest,
    browserNonce: state.browserNonce,
    pkceVerifier: state.pkceVerifier,
    oidcNonce: state.oidcNonce,
  })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM", typ: "JWT" })
    .setIssuer(origin)
    .setAudience(`${origin}/callback`)
    .setSubject(state.purpose)
    .setJti(state.browserNonce)
    .setIssuedAt(now)
    .setExpirationTime(now + STATE_TTL_SECONDS)
    .encrypt(await key(secret));
}

export async function verifyFlowState(
  token: string,
  expectedPurpose: FlowPurpose,
  secret: string,
  origin: string,
  now = Math.floor(Date.now() / 1000),
): Promise<FlowState> {
  const { payload } = await jwtDecrypt(token, await key(secret), {
    keyManagementAlgorithms: ["dir"],
    contentEncryptionAlgorithms: ["A256GCM"],
    typ: "JWT",
    issuer: origin,
    audience: `${origin}/callback`,
    subject: expectedPurpose,
    requiredClaims: ["exp", "iat", "jti", "sub"],
    currentDate: new Date(now * 1000),
  });

  if (
    typeof payload.browserNonce !== "string" ||
    payload.browserNonce !== payload.jti ||
    typeof payload.oauthRequest !== "object" ||
    payload.oauthRequest === null
  ) {
    throw new Error("invalid_flow_state");
  }

  const result: FlowState = {
    purpose: expectedPurpose,
    oauthRequest: payload.oauthRequest as unknown as AuthRequest,
    browserNonce: payload.browserNonce,
  };
  if (typeof payload.pkceVerifier === "string") {
    result.pkceVerifier = payload.pkceVerifier;
  }
  if (typeof payload.oidcNonce === "string") {
    result.oidcNonce = payload.oidcNonce;
  }
  return result;
}
