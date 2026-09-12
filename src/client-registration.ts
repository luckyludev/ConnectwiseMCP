import type { ClientRegistrationCallbackResult } from "@cloudflare/workers-oauth-provider";

const maxClientMetadataBytes = 16 * 1024;
const maxRedirectUriCount = 10;
const maxRedirectUriLength = 2_048;

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function reject(
  code = "invalid_redirect_uri",
  description = "Client redirect URI is not approved",
): ClientRegistrationCallbackResult {
  return {
    code,
    description,
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
    if (byteLength(value) > maxClientMetadataBytes) return [];
    const parsed: unknown = JSON.parse(value);
    if (
      !Array.isArray(parsed) ||
      parsed.length === 0 ||
      parsed.length > maxRedirectUriCount ||
      !parsed.every(
        (entry) =>
          typeof entry === "string" &&
          entry.length > 0 &&
          byteLength(entry) <= maxRedirectUriLength,
      ) ||
      new Set(parsed).size !== parsed.length
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

export function isConfiguredClientRedirectUri(
  value: string,
  configuredUris: string,
): boolean {
  const allowlist = allowedUris(configuredUris);
  return allowlist.length > 0 && matchesAllowedRedirect(value, allowlist);
}

export function validateClientRegistration(
  metadata: Record<string, unknown>,
  configuredUris: string,
  rawBodyByteLength: number,
): ClientRegistrationCallbackResult | undefined {
  if (
    !Number.isSafeInteger(rawBodyByteLength) ||
    rawBodyByteLength < 0 ||
    rawBodyByteLength > maxClientMetadataBytes
  ) {
    return reject("invalid_client_metadata", "Client metadata is too large");
  }
  const allowlist = allowedUris(configuredUris);
  const redirectUris = metadata.redirect_uris;
  if (
    allowlist.length === 0 ||
    !Array.isArray(redirectUris) ||
    redirectUris.length === 0 ||
    redirectUris.length > maxRedirectUriCount ||
    !redirectUris.every(
      (value) =>
        typeof value === "string" &&
        value.length > 0 &&
        byteLength(value) <= maxRedirectUriLength,
    ) ||
    new Set(redirectUris).size !== redirectUris.length
  ) {
    return reject();
  }

  for (const value of redirectUris as string[]) {
    if (!matchesAllowedRedirect(value, allowlist)) return reject();
  }
  return undefined;
}
