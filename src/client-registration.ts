import type { ClientRegistrationCallbackResult } from "@cloudflare/workers-oauth-provider";

function reject(): ClientRegistrationCallbackResult {
  return {
    code: "invalid_redirect_uri",
    description: "Client redirect URI is not approved",
    status: 400,
  };
}

type AllowedUri = { raw: string; url: URL };

function isLoopback(hostname: string): boolean {
  return (
    hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "localhost"
  );
}

function allowedUris(value: string): AllowedUri[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !Array.isArray(parsed) ||
      !parsed.every((entry) => typeof entry === "string")
    ) {
      return [];
    }
    const uris = parsed.map((raw) => ({ raw, url: new URL(raw) }));
    return uris.every(
      ({ raw, url }) =>
        !url.username &&
        !url.password &&
        !url.hash &&
        url.href === raw &&
        (url.protocol === "https:" ||
          (url.protocol === "http:" && isLoopback(url.hostname))),
    )
      ? uris
      : [];
  } catch {
    return [];
  }
}

function matchesAllowedRedirect(
  value: string,
  allowlist: AllowedUri[],
): boolean {
  let uri: URL;
  try {
    uri = new URL(value);
  } catch {
    return false;
  }
  if (uri.username || uri.password || uri.hash || uri.href !== value) {
    return false;
  }
  if (uri.protocol === "https:") {
    return allowlist.some((approved) => approved.raw === value);
  }
  if (uri.protocol === "http:" && isLoopback(uri.hostname)) {
    return allowlist.some(
      (candidate) =>
        candidate.url.protocol === "http:" &&
        isLoopback(candidate.url.hostname) &&
        candidate.url.hostname === uri.hostname &&
        candidate.url.pathname === uri.pathname &&
        candidate.url.search === uri.search,
    );
  }
  return false;
}

export function isApprovedClientRedirectUri(
  value: string,
  registeredUris: string[],
): boolean {
  if (registeredUris.length === 0) return false;
  const allowlist = allowedUris(JSON.stringify(registeredUris));
  return (
    allowlist.length === registeredUris.length &&
    matchesAllowedRedirect(value, allowlist)
  );
}

export function validateClientRegistration(
  metadata: Record<string, unknown>,
  configuredUris: string,
): ClientRegistrationCallbackResult | undefined {
  const allowlist = allowedUris(configuredUris);
  const redirectUris = metadata.redirect_uris;
  if (
    allowlist.length === 0 ||
    !Array.isArray(redirectUris) ||
    redirectUris.length === 0 ||
    !redirectUris.every((value) => typeof value === "string")
  ) {
    return reject();
  }

  for (const value of redirectUris as string[]) {
    if (!matchesAllowedRedirect(value, allowlist)) return reject();
  }
  return undefined;
}
