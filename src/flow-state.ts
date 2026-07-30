import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { SignJWT, jwtVerify } from "jose";

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

function key(secret: string): Uint8Array {
  if (encoder.encode(secret).byteLength < 32) {
    throw new Error("OAUTH_STATE_SECRET must be at least 32 bytes");
  }
  return encoder.encode(secret);
}

export async function signFlowState(
  state: FlowState,
  secret: string,
  origin: string,
  now = Math.floor(Date.now() / 1000),
): Promise<string> {
  return new SignJWT({
    oauthRequest: state.oauthRequest,
    browserNonce: state.browserNonce,
    pkceVerifier: state.pkceVerifier,
    oidcNonce: state.oidcNonce,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(origin)
    .setAudience(`${origin}/callback`)
    .setSubject(state.purpose)
    .setJti(state.browserNonce)
    .setIssuedAt(now)
    .setExpirationTime(now + STATE_TTL_SECONDS)
    .sign(key(secret));
}

export async function verifyFlowState(
  token: string,
  expectedPurpose: FlowPurpose,
  secret: string,
  origin: string,
  now = Math.floor(Date.now() / 1000),
): Promise<FlowState> {
  const { payload } = await jwtVerify(token, key(secret), {
    algorithms: ["HS256"],
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
