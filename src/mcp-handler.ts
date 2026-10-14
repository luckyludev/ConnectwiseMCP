import {
  createMcpHandler as createSdkMcpHandler,
  type AuthInfo,
  type McpServer,
} from "@modelcontextprotocol/server";

export type McpAuthContext = {
  props: Record<string, unknown>;
};

type WorkerOAuthContext = ExecutionContext & {
  props?: unknown;
  auth?: {
    token?: unknown;
    audience?: unknown;
    expiresAt?: unknown;
    scope?: unknown;
    clientId?: unknown;
  };
};

type HandlerOptions = {
  route?: string;
  corsOptions?: false;
  legacy?: "stateless" | "reject";
  maxRequestBodySize?: number;
  onerror?: (error: Error) => void;
};

type RequestOptions = {
  authInfo?: AuthInfo;
  parsedBody?: unknown;
};

type McpServerFactory = () => McpServer;

let activeConstructionAuthContext: McpAuthContext | undefined;

export function getMcpAuthContext(): McpAuthContext | undefined {
  return activeConstructionAuthContext;
}

function constructWithAuthContext(
  context: McpAuthContext,
  factory: McpServerFactory,
): McpServer {
  const previous = activeConstructionAuthContext;
  activeConstructionAuthContext = context;
  try {
    return factory();
  } finally {
    activeConstructionAuthContext = previous;
  }
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function authorizedScopeSnapshot(value: unknown): string[] | undefined {
  try {
    if (!Array.isArray(value)) return undefined;
    const scopeCount = value.length;
    if (scopeCount > 16) return undefined;

    let hasRead = false;
    const snapshot: string[] = [];
    for (let index = 0; index < scopeCount; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) return undefined;
      const scope: unknown = value[index];
      if (typeof scope !== "string") return undefined;
      if (scope === "mcp:read") hasRead = true;
      snapshot.push(scope);
    }
    return hasRead ? snapshot : undefined;
  } catch {
    return undefined;
  }
}

function authInfoFromWorkerContext(context: WorkerOAuthContext): AuthInfo {
  const auth = context.auth;
  if (!plainRecord(auth)) {
    throw new TypeError("Invalid verified OAuth request context");
  }
  const scopeSnapshot = authorizedScopeSnapshot(auth.scope);
  if (scopeSnapshot === undefined) {
    throw new TypeError("Invalid verified OAuth request context");
  }
  const { token, clientId, expiresAt, audience } = auth;
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    typeof clientId !== "string" ||
    clientId.length === 0
  ) {
    throw new TypeError("Invalid verified OAuth request context");
  }
  if (!plainRecord(context.props)) {
    throw new TypeError("Invalid verified OAuth request context");
  }
  if (
    expiresAt !== undefined &&
    (typeof expiresAt !== "number" ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= 0)
  ) {
    throw new TypeError("Invalid verified OAuth request context");
  }

  let resource: URL | undefined;
  if (audience !== undefined) {
    if (typeof audience !== "string") {
      throw new TypeError("Invalid verified OAuth request context");
    }
    resource = new URL(audience);
    if (resource.protocol !== "https:" && resource.protocol !== "http:") {
      throw new TypeError("Invalid verified OAuth request context");
    }
  }

  const verifiedProps = { ...context.props, scopes: scopeSnapshot };
  return {
    token,
    clientId,
    scopes: scopeSnapshot,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(resource === undefined ? {} : { resource }),
    extra: { props: verifiedProps },
  };
}

function authContextFromInfo(
  authInfo: AuthInfo | undefined,
): McpAuthContext | undefined {
  const scopes = authorizedScopeSnapshot(authInfo?.scopes);
  if (scopes === undefined) {
    return undefined;
  }
  const props = authInfo?.extra?.props;
  if (!plainRecord(props)) {
    return undefined;
  }
  return { props: { ...props, scopes: [...scopes] } };
}

export function createMcpHandler(
  factory: McpServerFactory,
  options: HandlerOptions = {},
) {
  const {
    route = "/mcp",
    corsOptions = false,
    legacy = "stateless",
    maxRequestBodySize = 16 * 1024 * 1024,
    ...sdkOptions
  } = options;
  if (corsOptions !== false) {
    throw new TypeError("Only disabled MCP CORS handling is supported");
  }

  const sdkHandler = createSdkMcpHandler(
    ({ authInfo }) => {
      const resolved = authContextFromInfo(authInfo);
      return resolved ? constructWithAuthContext(resolved, factory) : factory();
    },
    { legacy, maxRequestBodySize, ...sdkOptions },
  );

  const serve = async (request: Request, requestOptions?: RequestOptions) => {
    const requestUrl = new URL(request.url);
    if (requestUrl.pathname !== route) {
      return new Response("Not Found", { status: 404 });
    }

    const host = request.headers.get("host");
    if (host !== null && host !== requestUrl.host) {
      return new Response("Misdirected request", {
        status: 421,
        headers: { "Cache-Control": "no-store" },
      });
    }

    const origin = request.headers.get("origin");
    if (origin !== null) {
      let originUrl: URL;
      try {
        originUrl = new URL(origin);
      } catch {
        return new Response("Forbidden origin", {
          status: 403,
          headers: { "Cache-Control": "no-store" },
        });
      }
      if (originUrl.origin !== requestUrl.origin) {
        return new Response("Forbidden origin", {
          status: 403,
          headers: { "Cache-Control": "no-store" },
        });
      }
    }

    return sdkHandler.fetch(request, requestOptions);
  };

  const callable = async (
    request: Request,
    _env: unknown,
    context: ExecutionContext,
  ) => {
    try {
      return await serve(request, {
        authInfo: authInfoFromWorkerContext(context as WorkerOAuthContext),
      });
    } catch (error) {
      sdkOptions.onerror?.(
        error instanceof Error ? error : new Error(String(error)),
      );
      return Response.json(
        {
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        },
        { status: 500 },
      );
    }
  };

  return Object.assign(callable, {
    fetch: serve,
    notify: sdkHandler.notify,
  });
}
