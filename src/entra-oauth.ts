export type EntraOAuthConfig = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
};

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

async function parseTokenResponse(response: Response): Promise<EntraTokenSet> {
  if (!response.ok) {
    let code: string | undefined;
    try {
      const body: unknown = await response.json();
      if (typeof body === "object" && body !== null) {
        const error = (body as Record<string, unknown>).error;
        if (typeof error === "string") code = error;
      }
    } catch {
      // Preserve the HTTP failure even when Entra returns a non-JSON body.
    }
    throw new EntraOAuthError(response.status, code);
  }
  const data: unknown = await response.json();
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
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
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
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  return parseTokenResponse(response);
}

export function buildEntraAuthorizationUrl(
  config: EntraOAuthConfig,
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
