import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { EntraIdentityClaims } from "./auth-policy";

const ENTRA_MAX_TOKEN_AGE_SECONDS = 7_200;

export type EntraJwtConfig = {
  issuer: string;
  audience: string;
  tenantId: string;
};

export function createEntraJwks(tenantId: string): JWTVerifyGetKey {
  const jwksUrl = new URL(
    `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/discovery/v2.0/keys`,
  );
  return createRemoteJWKSet(jwksUrl, {
    cooldownDuration: 30_000,
    cacheMaxAge: 3_600_000,
    timeoutDuration: 5_000,
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
