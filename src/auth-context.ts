import type { EntraAccessTokenProps } from "./auth-handler";

export type AuthProps = Partial<EntraAccessTokenProps> | undefined;

export function hasAuthenticatedProfile(
  props: AuthProps,
): props is NonNullable<AuthProps> & { profileAlias: string } {
  return (
    typeof props?.profileAlias === "string" &&
    /^[A-Z][A-Z0-9_]{0,31}$/.test(props.profileAlias)
  );
}

function snapshotStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("Invalid identity string array");
  const snapshot: string[] = [];
  const length = value.length;
  for (let index = 0; index < length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      throw new Error("Invalid identity string array");
    }
    const entry: unknown = value[index];
    if (typeof entry !== "string") {
      throw new Error("Invalid identity string array");
    }
    snapshot.push(entry);
  }
  return snapshot;
}

export function snapshotAuthProps(
  props: NonNullable<AuthProps>,
  scopes: readonly string[],
): NonNullable<AuthProps> {
  const tenantId = props.tenantId;
  const objectId = props.objectId;
  const profileAlias = props.profileAlias;
  const groups: unknown = props.groups;
  const roles: unknown = props.roles;
  return {
    ...(tenantId !== undefined ? { tenantId } : {}),
    ...(objectId !== undefined ? { objectId } : {}),
    ...(profileAlias !== undefined ? { profileAlias } : {}),
    ...(groups !== undefined ? { groups: snapshotStringArray(groups) } : {}),
    ...(roles !== undefined ? { roles: snapshotStringArray(roles) } : {}),
    scopes: [...scopes],
  };
}

export function trySnapshotAuthProps(
  props: NonNullable<AuthProps>,
  scopes: readonly string[],
): NonNullable<AuthProps> | undefined {
  try {
    return snapshotAuthProps(props, scopes);
  } catch {
    return undefined;
  }
}
