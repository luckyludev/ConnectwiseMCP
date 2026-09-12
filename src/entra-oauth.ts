export type EntraOAuthConfig = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
};

export type EntraAuthorizationConfig = Omit<EntraOAuthConfig, "clientSecret">;

export type EntraAuthorizationParameters = {
  state: string;
  codeChallenge: string;
  nonce: string;
};

export type EntraTokenSet = {
  idToken: string;
  refreshToken: string;
  expiresIn: number;
};

type Fetcher = typeof fetch;

const MAX_TOKEN_RESPONSE_BYTES = 65_536;
const TOKEN_REQUEST_TIMEOUT_MS = 15_000;

export class EntraOAuthError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
  ) {
    super(`entra_token_exchange_failed:${status}`);
    this.name = "EntraOAuthError";
  }
}

function tokenEndpoint(config: EntraOAuthConfig): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/token`;
}

async function cancelBody(
  body: ReadableStream<Uint8Array> | null,
): Promise<void> {
  try {
    await body?.cancel();
  } catch {
    // The stream may already be errored; rejection remains fail-closed.
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get("Content-Length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > MAX_TOKEN_RESPONSE_BYTES
    ) {
      await cancelBody(response.body);
      throw new Error("invalid_entra_token_response");
    }
  }

  if (!response.body) throw new Error("invalid_entra_token_response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.byteLength > MAX_TOKEN_RESPONSE_BYTES) {
        throw new Error("invalid_entra_token_response");
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
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("invalid_entra_token_response");
  }
}

async function parseTokenResponse(response: Response): Promise<EntraTokenSet> {
  if (!response.ok) {
    let code: string | undefined;
    try {
      const body = await readBoundedJson(response);
      if (typeof body === "object" && body !== null) {
        const error = (body as Record<string, unknown>).error;
        if (typeof error === "string") code = error;
      }
    } catch {
      // Preserve the HTTP failure when Entra returns invalid or oversized JSON.
    }
    throw new EntraOAuthError(response.status, code);
  }
  const data = await readBoundedJson(response);
  if (typeof data !== "object" || data === null) {
    throw new Error("invalid_entra_token_response");
  }
  const record = data as Record<string, unknown>;
  if (
    typeof record.id_token !== "string" ||
    typeof record.refresh_token !== "string" ||
    typeof record.expires_in !== "number" ||
    record.expires_in <= 0
  ) {
    throw new Error("invalid_entra_token_response");
  }
  return {
    idToken: record.id_token,
    refreshToken: record.refresh_token,
    expiresIn: record.expires_in,
  };
}

export async function exchangeEntraAuthorizationCode(
  config: EntraOAuthConfig,
  parameters: { code: string; codeVerifier: string },
  fetcher: Fetcher = fetch,
): Promise<EntraTokenSet> {
  if (!parameters.code || !parameters.codeVerifier) {
    throw new Error("missing_authorization_code_or_pkce_verifier");
  }
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code: parameters.code,
    code_verifier: parameters.codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: config.callbackUrl,
    scope: "openid profile email offline_access",
  });
  const response = await fetcher(tokenEndpoint(config), {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
  });
  return parseTokenResponse(response);
}

export async function refreshEntraTokens(
  config: EntraOAuthConfig,
  refreshToken: string,
  fetcher: Fetcher = fetch,
): Promise<EntraTokenSet> {
  if (!refreshToken) {
    throw new Error("missing_entra_refresh_token");
  }
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: "openid profile email offline_access",
  });
  const response = await fetcher(tokenEndpoint(config), {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
  });
  return parseTokenResponse(response);
}

export function buildEntraAuthorizationUrl(
  config: EntraAuthorizationConfig,
  parameters: EntraAuthorizationParameters,
): URL {
  const url = new URL(
    `https://login.microsoftonline.com/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/authorize`,
  );
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.callbackUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("scope", "openid profile email offline_access");
  url.searchParams.set("code_challenge", parameters.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("nonce", parameters.nonce);
  url.searchParams.set("state", parameters.state);
  return url;
}
