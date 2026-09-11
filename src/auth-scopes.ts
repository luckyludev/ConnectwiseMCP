import type { EntraAccessTokenProps } from "./auth-handler";

export type McpScope = "mcp:read" | "mcp:write";

export function hasMcpScopes(
  props: Partial<EntraAccessTokenProps> | undefined,
  requiredScopes: readonly McpScope[],
): props is Partial<EntraAccessTokenProps> & { scopes: string[] } {
  try {
    const scopes: unknown = props?.scopes;
    if (!Array.isArray(scopes)) return false;
    const scopeCount = scopes.length;
    if (scopeCount > 16) return false;

    const scopeSnapshot: string[] = [];
    for (let index = 0; index < scopeCount; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(scopes, index)) return false;
      const scope: unknown = scopes[index];
      if (typeof scope !== "string") return false;
      scopeSnapshot.push(scope);
    }

    for (const requiredScope of requiredScopes) {
      let found = false;
      for (const scope of scopeSnapshot) {
        if (scope === requiredScope) {
          found = true;
          break;
        }
      }
      if (!found) return false;
    }
    return true;
  } catch {
    return false;
  }
}
