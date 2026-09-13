import type { ClientRegistrationCallbackResult } from "@cloudflare/workers-oauth-provider";

export const MAX_CLIENT_METADATA_BYTES = 16 * 1024;
const MAX_CLIENT_METADATA_CHUNKS = 256;
const maxRedirectUriCount = 10;
const maxRedirectUriLength = 2_048;

function metadataErrorResponse(
  request: Request,
  status: 400 | 413,
  description: string,
): Response {
  const headers = new Headers({
    "cache-control": "no-store",
    "content-type": "application/json",
    pragma: "no-cache",
  });
  const origin = request.headers.get("origin");
  if (origin) {
    headers.set("access-control-allow-origin", origin);
    headers.set("access-control-allow-methods", "*");
    headers.set("access-control-allow-headers", "Authorization, *");
    headers.set("access-control-max-age", "86400");
  }
  return Response.json(
    {
      error: "invalid_client_metadata",
      error_description: description,
    },
    { status, headers },
  );
}

export async function prepareClientRegistrationRequest(
  request: Request,
): Promise<Request | Response> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^(0|[1-9]\d*)$/.test(declaredLength)) {
      return metadataErrorResponse(
        request,
        400,
        "Invalid client metadata length",
      );
    }
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength)) {
      return metadataErrorResponse(
        request,
        413,
        "Client metadata is too large",
      );
    }
    if (parsedLength > MAX_CLIENT_METADATA_BYTES) {
      return metadataErrorResponse(
        request,
        413,
        "Client metadata is too large",
      );
    }
  }

  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let chunkCount = 0;
  const reader = request.body?.getReader();
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunkCount += 1;
        if (
          chunkCount > MAX_CLIENT_METADATA_CHUNKS ||
          byteLength + value.byteLength > MAX_CLIENT_METADATA_BYTES
        ) {
          await reader.cancel().catch(() => undefined);
          return metadataErrorResponse(
            request,
            413,
            "Client metadata is too large",
          );
        }
        if (value.byteLength === 0) continue;
        byteLength += value.byteLength;
        chunks.push(value);
      }
    } catch {
      await reader.cancel().catch(() => undefined);
      return metadataErrorResponse(
        request,
        400,
        "Invalid client metadata body",
      );
    }
  }

  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const headers = new Headers(request.headers);
  headers.set("content-length", String(byteLength));
  return new Request(request, { headers, body: body.buffer });
}

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
    if (byteLength(value) > MAX_CLIENT_METADATA_BYTES) return [];
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
    rawBodyByteLength > MAX_CLIENT_METADATA_BYTES
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
