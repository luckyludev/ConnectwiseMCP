export type EntraIdentityClaims = {
  tid?: unknown;
  oid?: unknown;
  groups?: unknown;
  roles?: unknown;
  hasgroups?: unknown;
  _claim_names?: unknown;
};

export type AuthorizationPolicyConfig = {
  tenantId: string;
  identityProfileMap: string;
  allowedGroupIds: string;
  allowedAppRoles: string;
};

export type ResolvedCredentialProfile = {
  tenantId: string;
  objectId: string;
  profileAlias: string;
};

export type AuthorizationPolicyErrorCode =
  | "invalid_configuration"
  | "missing_identity"
  | "wrong_tenant"
  | "not_authorized"
  | "group_overage"
  | "unmapped_identity"
  | "ambiguous_identity";

export class AuthorizationPolicyError extends Error {
  readonly code: AuthorizationPolicyErrorCode;

  constructor(code: AuthorizationPolicyErrorCode) {
    super(code);
    this.name = "AuthorizationPolicyError";
    this.code = code;
  }
}

const PROFILE_ALIAS_PATTERN = /^[A-Z][A-Z0-9_]{0,31}$/;

function parseIdentityProfileMap(
  value: string,
  configuredTenantId: string,
): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error("not an object");
    }

    const entries = Object.entries(parsed as Record<string, unknown>);
    const aliases = new Set<string>();
    const tenantPrefix = `${configuredTenantId}:`;
    for (const [identity, alias] of entries) {
      if (
        !identity.startsWith(tenantPrefix) ||
        identity.length === tenantPrefix.length ||
        typeof alias !== "string" ||
        !PROFILE_ALIAS_PATTERN.test(alias) ||
        aliases.has(alias)
      ) {
        throw new Error("invalid identity profile map");
      }
      aliases.add(alias);
    }

    return Object.fromEntries(entries) as Record<string, string>;
  } catch {
    throw new AuthorizationPolicyError("invalid_configuration");
  }
}

function parseStringSet(value: string): Set<string> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !Array.isArray(parsed) ||
      !parsed.every((entry) => typeof entry === "string")
    ) {
      throw new Error("not a string array");
    }
    return new Set(parsed);
  } catch {
    throw new AuthorizationPolicyError("invalid_configuration");
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function hasGroupOverage(claims: EntraIdentityClaims): boolean {
  if (claims.hasgroups === true) return true;
  if (typeof claims._claim_names !== "object" || claims._claim_names === null) {
    return false;
  }
  return "groups" in claims._claim_names;
}

export function resolveCredentialProfile(
  claims: EntraIdentityClaims,
  config: AuthorizationPolicyConfig,
): ResolvedCredentialProfile {
  const tenantId = typeof claims.tid === "string" ? claims.tid : "";
  const objectId = typeof claims.oid === "string" ? claims.oid : "";
  if (!tenantId || !objectId) {
    throw new AuthorizationPolicyError("missing_identity");
  }
  if (tenantId !== config.tenantId) {
    throw new AuthorizationPolicyError("wrong_tenant");
  }

  const allowedGroups = parseStringSet(config.allowedGroupIds);
  const allowedRoles = parseStringSet(config.allowedAppRoles);
  if (allowedGroups.size === 0 && allowedRoles.size === 0) {
    throw new AuthorizationPolicyError("invalid_configuration");
  }

  const roleAuthorized = stringArray(claims.roles).some((role) =>
    allowedRoles.has(role),
  );
  const groupAuthorized = stringArray(claims.groups).some((group) =>
    allowedGroups.has(group),
  );
  if (!roleAuthorized && !groupAuthorized) {
    if (allowedGroups.size > 0 && hasGroupOverage(claims)) {
      throw new AuthorizationPolicyError("group_overage");
    }
    throw new AuthorizationPolicyError("not_authorized");
  }

  const profileMap = parseIdentityProfileMap(
    config.identityProfileMap,
    config.tenantId,
  );
  const profileAlias = profileMap[`${tenantId}:${objectId}`];

  if (!profileAlias) {
    throw new AuthorizationPolicyError("unmapped_identity");
  }

  return { tenantId, objectId, profileAlias };
}
