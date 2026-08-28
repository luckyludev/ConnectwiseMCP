import type {
  OAuthHelpers,
  AuthRequest,
  TokenExchangeCallbackOptions,
  TokenExchangeCallbackResult,
} from "@cloudflare/workers-oauth-provider";
import type { JWTVerifyGetKey } from "jose";
import {
  AuthorizationPolicyError,
  resolveCredentialProfile,
  type EntraIdentityClaims,
} from "./auth-policy";
import { isApprovedClientRedirectUri } from "./client-registration";
import { renderConsentPage } from "./consent";
import { createEntraJwks, verifyEntraAccessToken } from "./entra-jwt";
import {
  buildEntraAuthorizationUrl,
  EntraOAuthError,
  exchangeEntraAuthorizationCode,
  refreshEntraTokens,
} from "./entra-oauth";
import { signFlowState, verifyFlowState } from "./flow-state";

export type WorkerEnv = {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  OAUTH_STATE_SECRET: string;
  ENTRA_TENANT_ID: string;
  ENTRA_CLIENT_ID: string;
  ENTRA_CLIENT_SECRET: string;
  MCP_CANONICAL_URL: string;
  IDENTITY_PROFILE_MAP: string;
  ALLOWED_GROUP_IDS: string;
  ALLOWED_APP_ROLES: string;
  ALLOWED_CLIENT_REDIRECT_URIS: string;
  CONNECTWISE_ALLOWED_ORIGINS: string;
};

export type EntraGrantProps = {
  tenantId: string;
  objectId: string;
  profileAlias: string;
  groups: string[];
  roles: string[];
  upstreamRefreshToken: string;
  upstreamExpiresIn: number;
};

export type EntraAccessTokenProps = Omit<
  EntraGrantProps,
  "upstreamRefreshToken" | "upstreamExpiresIn"
> & {
  scopes: string[];
};

export type AuthHandlerDependencies = {
  fetcher?: typeof fetch;
  getKey?: JWTVerifyGetKey;
};

function cookie(name: string, value: string, maxAge = 600): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("Cookie") ?? "";
  for (const entry of header.split(";")) {
    const [key, ...parts] = entry.trim().split("=");
    if (key === name) return parts.join("=");
  }
  return undefined;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function oauthUserId(tenantId: string, objectId: string): string {
  // workers-oauth-provider uses ':' as the authorization-code field delimiter,
  // so the subject itself must not contain that character.
  return base64Url(new TextEncoder().encode(`${tenantId}:${objectId}`));
}

async function createPkce(): Promise<{ verifier: string; challenge: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(64));
  const verifier = base64Url(bytes);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

async function equalTokens(left: string, right: string): Promise<boolean> {
  const digest = async (value: string) =>
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    );
  const [a, b] = await Promise.all([digest(left), digest(right)]);
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

function isCanonicalHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.hash &&
      url.href === value
    );
  } catch {
    return false;
  }
}

async function beginAuthorization(
  request: Request,
  env: WorkerEnv,
): Promise<Response> {
  if (!isCanonicalHttpsUrl(env.MCP_CANONICAL_URL)) {
    return new Response("Invalid server configuration", {
      status: 500,
      headers: { "Cache-Control": "no-store" },
    });
  }

  let oauthRequest: AuthRequest;
  try {
    oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch {
    console.log("[auth] stage=authorize_parse fail (parseAuthRequest threw)");
    return new Response("Invalid authorization request", {
      status: 400,
      headers: { "X-Auth-Stage": "authorize_parse" },
    });
  }

  if (oauthRequest.resource !== env.MCP_CANONICAL_URL) {
    return new Response("Invalid authorization resource", { status: 400 });
  }

  const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
  if (!client) {
    return new Response("Unknown OAuth client", { status: 400 });
  }
  if (
    typeof oauthRequest.redirectUri !== "string" ||
    !isApprovedClientRedirectUri(oauthRequest.redirectUri, client.redirectUris)
  ) {
    return new Response("Invalid client redirect URI", {
      status: 400,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const csrfToken = crypto.randomUUID();
  const browserNonce = crypto.randomUUID();
  const origin = new URL(env.MCP_CANONICAL_URL).origin;
  const signedState = await signFlowState(
    {
      purpose: "consent",
      oauthRequest,
      browserNonce,
    },
    env.OAUTH_STATE_SECRET,
    origin,
  );
  const response = renderConsentPage({
    clientName: client.clientName ?? "MCP client",
    scopes: oauthRequest.scope,
    signedState,
    csrfToken,
    origin,
    clientRedirectUri: oauthRequest.redirectUri,
  });
  const headers = new Headers(response.headers);
  headers.append("Set-Cookie", cookie("__Host-CW_CSRF", csrfToken));
  return new Response(response.body, { status: response.status, headers });
}

async function continueAuthorization(
  request: Request,
  env: WorkerEnv,
): Promise<Response> {
  if (
    !(request.headers.get("Content-Type") ?? "").startsWith(
      "application/x-www-form-urlencoded",
    )
  ) {
    return new Response("Invalid request", { status: 400 });
  }
  const form = await request.formData();
  const signedConsent = form.get("flow_state");
  const csrfFromForm = form.get("csrf_token");
  const csrfFromCookie = readCookie(request, "__Host-CW_CSRF");
  if (
    typeof signedConsent !== "string" ||
    typeof csrfFromForm !== "string" ||
    !csrfFromCookie ||
    !(await equalTokens(csrfFromForm, csrfFromCookie))
  ) {
    console.log("[auth] stage=authorize_consent fail", {
      has_flow_state: typeof signedConsent === "string",
      has_form_csrf: typeof csrfFromForm === "string",
      has_cookie_csrf: !!csrfFromCookie,
    });
    return new Response("Invalid authorization request", {
      status: 400,
      headers: { "X-Auth-Stage": "authorize_consent" },
    });
  }

  const origin = new URL(env.MCP_CANONICAL_URL).origin;
  let consent;
  try {
    consent = await verifyFlowState(
      signedConsent,
      "consent",
      env.OAUTH_STATE_SECRET,
      origin,
    );
  } catch {
    console.log(
      "[auth] stage=authorize_consent fail flow_state_verify (tampered/expired/missing claims)",
    );
    return new Response("Invalid or expired authorization request", {
      status: 400,
      headers: { "X-Auth-Stage": "authorize_consent_state" },
    });
  }

  const { verifier, challenge } = await createPkce();
  const browserNonce = crypto.randomUUID();
  const oidcNonce = crypto.randomUUID();
  const upstreamState = await signFlowState(
    {
      purpose: "entra_callback",
      oauthRequest: consent.oauthRequest,
      browserNonce,
      pkceVerifier: verifier,
      oidcNonce,
    },
    env.OAUTH_STATE_SECRET,
    origin,
  );
  const location = buildEntraAuthorizationUrl(
    {
      tenantId: env.ENTRA_TENANT_ID,
      clientId: env.ENTRA_CLIENT_ID,
      clientSecret: env.ENTRA_CLIENT_SECRET,
      callbackUrl: `${origin}/callback`,
    },
    { state: upstreamState, codeChallenge: challenge, nonce: oidcNonce },
  );
  const headers = new Headers({
    "Cache-Control": "no-store",
    Location: location.toString(),
  });
  headers.append("Set-Cookie", cookie("__Host-CW_ENTRA_STATE", browserNonce));
  headers.append("Set-Cookie", cookie("__Host-CW_CSRF", "", 0));
  return new Response(null, { status: 302, headers });
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function accessTokenProps(
  props: EntraGrantProps,
  scopes: string[],
): EntraAccessTokenProps {
  return {
    tenantId: props.tenantId,
    objectId: props.objectId,
    profileAlias: props.profileAlias,
    groups: props.groups,
    roles: props.roles,
    scopes,
  };
}

function isTerminalGrantFailure(error: unknown): boolean {
  if (error instanceof EntraOAuthError) return error.code === "invalid_grant";
  if (error instanceof AuthorizationPolicyError) {
    return error.code !== "invalid_configuration";
  }
  return (
    error instanceof Error && error.message === "identity_or_profile_changed"
  );
}

async function completeEntraCallback(
  request: Request,
  env: WorkerEnv,
  dependencies: AuthHandlerDependencies,
): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const signedState = url.searchParams.get("state");
  if (url.searchParams.has("error") || !code || !signedState) {
    console.log("[auth] stage=callback fail", {
      ms_returned_error: url.searchParams.has("error"),
      has_code: !!code,
      has_state: !!signedState,
    });
    return new Response("Authentication failed", {
      status: 400,
      headers: { "X-Auth-Stage": "callback_error_param" },
    });
  }

  const origin = new URL(env.MCP_CANONICAL_URL).origin;
  let state;
  try {
    state = await verifyFlowState(
      signedState,
      "entra_callback",
      env.OAUTH_STATE_SECRET,
      origin,
    );
  } catch {
    console.log(
      "[auth] stage=callback fail state_verify (signed state invalid/expired)",
    );
    return new Response("Invalid or expired authentication state", {
      status: 400,
      headers: { "X-Auth-Stage": "callback_state" },
    });
  }
  const cookieNonce = readCookie(request, "__Host-CW_ENTRA_STATE");
  if (
    !cookieNonce ||
    !(await equalTokens(cookieNonce, state.browserNonce)) ||
    !state.pkceVerifier ||
    !state.oidcNonce
  ) {
    console.log(
      "[auth] stage=callback fail session_cookie (nonce/pkce/oidc presence)",
      {
        has_cookie: !!cookieNonce,
        cookie_match:
          !!cookieNonce && (await equalTokens(cookieNonce, state.browserNonce)),
        has_pkce: !!state.pkceVerifier,
        has_oidc_nonce: !!state.oidcNonce,
      },
    );
    return new Response("Invalid authentication session", {
      status: 400,
      headers: { "X-Auth-Stage": "callback_session" },
    });
  }

  const oauthConfig = {
    tenantId: env.ENTRA_TENANT_ID,
    clientId: env.ENTRA_CLIENT_ID,
    clientSecret: env.ENTRA_CLIENT_SECRET,
    callbackUrl: `${origin}/callback`,
  };
  try {
    const tokenSet = await exchangeEntraAuthorizationCode(
      oauthConfig,
      { code, codeVerifier: state.pkceVerifier },
      dependencies.fetcher ?? fetch,
    );
    const claims = await verifyEntraAccessToken(
      tokenSet.idToken,
      {
        issuer: `https://login.microsoftonline.com/${env.ENTRA_TENANT_ID}/v2.0`,
        audience: env.ENTRA_CLIENT_ID,
        tenantId: env.ENTRA_TENANT_ID,
      },
      dependencies.getKey ?? createEntraJwks(env.ENTRA_TENANT_ID),
      { expectedNonce: state.oidcNonce },
    );
    const profile = resolveCredentialProfile(claims, {
      tenantId: env.ENTRA_TENANT_ID,
      identityProfileMap: env.IDENTITY_PROFILE_MAP,
      allowedGroupIds: env.ALLOWED_GROUP_IDS,
      allowedAppRoles: env.ALLOWED_APP_ROLES,
    });
    const props: EntraGrantProps = {
      tenantId: profile.tenantId,
      objectId: profile.objectId,
      profileAlias: profile.profileAlias,
      groups: strings((claims as EntraIdentityClaims).groups),
      roles: strings((claims as EntraIdentityClaims).roles),
      upstreamRefreshToken: tokenSet.refreshToken,
      upstreamExpiresIn: tokenSet.expiresIn,
    };
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: state.oauthRequest,
      userId: oauthUserId(profile.tenantId, profile.objectId),
      metadata: { label: profile.profileAlias },
      scope: state.oauthRequest.scope.filter((scope) => scope === "mcp:read"),
      props,
    });
    const headers = new Headers({
      "Cache-Control": "no-store",
      Location: redirectTo,
    });
    headers.append("Set-Cookie", cookie("__Host-CW_ENTRA_STATE", "", 0));
    return new Response(null, { status: 302, headers });
  } catch (error) {
    console.log("[auth] stage=callback fail exchange_or_policy", {
      error_name: error instanceof Error ? error.name : typeof error,
    });
    return new Response("Authentication or authorization failed", {
      status: 403,
      headers: {
        "Cache-Control": "no-store",
        "X-Auth-Stage": "callback_exchange",
      },
    });
  }
}

export function createTokenExchangeCallback(
  env: WorkerEnv,
  dependencies: AuthHandlerDependencies = {},
): (
  options: TokenExchangeCallbackOptions,
) => Promise<TokenExchangeCallbackResult | void> {
  return async (options) => {
    const props = options.props as EntraGrantProps;
    if (options.grantType === "authorization_code") {
      return {
        accessTokenTTL: Math.min(props.upstreamExpiresIn, 3600),
        refreshTokenTTL: 2_592_000,
        newProps: props,
        accessTokenProps: accessTokenProps(props, options.requestedScope),
      };
    }
    if (options.grantType !== "refresh_token") return;

    try {
      const tokenSet = await refreshEntraTokens(
        {
          tenantId: env.ENTRA_TENANT_ID,
          clientId: env.ENTRA_CLIENT_ID,
          clientSecret: env.ENTRA_CLIENT_SECRET,
          callbackUrl: `${new URL(env.MCP_CANONICAL_URL).origin}/callback`,
        },
        props.upstreamRefreshToken,
        dependencies.fetcher ?? fetch,
      );
      const claims = await verifyEntraAccessToken(
        tokenSet.idToken,
        {
          issuer: `https://login.microsoftonline.com/${env.ENTRA_TENANT_ID}/v2.0`,
          audience: env.ENTRA_CLIENT_ID,
          tenantId: env.ENTRA_TENANT_ID,
        },
        dependencies.getKey ?? createEntraJwks(env.ENTRA_TENANT_ID),
      );
      const profile = resolveCredentialProfile(claims, {
        tenantId: env.ENTRA_TENANT_ID,
        identityProfileMap: env.IDENTITY_PROFILE_MAP,
        allowedGroupIds: env.ALLOWED_GROUP_IDS,
        allowedAppRoles: env.ALLOWED_APP_ROLES,
      });
      if (
        profile.tenantId !== props.tenantId ||
        profile.objectId !== props.objectId ||
        profile.profileAlias !== props.profileAlias
      ) {
        throw new Error("identity_or_profile_changed");
      }
      const newProps: EntraGrantProps = {
        ...props,
        groups: strings(claims.groups),
        roles: strings(claims.roles),
        upstreamRefreshToken: tokenSet.refreshToken,
        upstreamExpiresIn: tokenSet.expiresIn,
      };
      return {
        accessTokenTTL: Math.min(tokenSet.expiresIn, 3600),
        newProps,
        accessTokenProps: accessTokenProps(newProps, options.requestedScope),
      };
    } catch (error) {
      if (isTerminalGrantFailure(error)) {
        await env.OAUTH_PROVIDER?.revokeGrant(options.grantId, options.userId);
      }
      throw error;
    }
  };
}

export function createEntraAuthHandler(
  dependencies: AuthHandlerDependencies = {},
): ExportedHandler<WorkerEnv> {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      if (url.pathname === "/authorize" && request.method === "GET") {
        return beginAuthorization(request, env);
      }
      if (url.pathname === "/authorize" && request.method === "POST") {
        return continueAuthorization(request, env);
      }
      if (url.pathname === "/callback" && request.method === "GET") {
        return completeEntraCallback(request, env, dependencies);
      }
      return new Response("Not found", { status: 404 });
    },
  };
}
