import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { env as cloudflareEnv } from "cloudflare:workers";
import {
  createEntraAuthHandler,
  createTokenExchangeCallback,
  isCanonicalMcpResource,
  type WorkerEnv,
} from "./auth-handler";
import {
  prepareClientRegistrationRequest,
  validateClientRegistration,
} from "./client-registration";
import { createMcpServer } from "./mcp-server";
import { prepareMcpRequest } from "./mcp-request";
import { prepareOAuthTokenRequest } from "./oauth-token-request";

const runtimeEnv = cloudflareEnv as unknown as WorkerEnv;
const mcpHandler = createMcpHandler(() => createMcpServer(runtimeEnv), {
  route: "/mcp",
  corsOptions: false,
});

const apiHandler = {
  async fetch(request: Request, env: WorkerEnv, context: ExecutionContext) {
    const prepared = await prepareMcpRequest(request);
    if (prepared instanceof Response) return prepared;
    return mcpHandler(prepared, env, context);
  },
} satisfies Pick<Required<ExportedHandler<WorkerEnv>>, "fetch">;

const oauthProvider = new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler,
  defaultHandler: createEntraAuthHandler(),
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  scopesSupported: ["mcp:read"],
  resourceMetadata: {
    resource: runtimeEnv.MCP_CANONICAL_URL,
    authorization_servers: [new URL(runtimeEnv.MCP_CANONICAL_URL).origin],
    scopes_supported: ["mcp:read"],
    resource_name: "ConnectWise MCP v2",
  },
  clientIdMetadataDocumentEnabled: true,
  clientRegistrationTTL: 604_800,
  allowPlainPKCE: false,
  allowImplicitFlow: false,
  tokenExchangeCallback: createTokenExchangeCallback(runtimeEnv),
  clientRegistrationCallback: ({ clientMetadata, request }) =>
    validateClientRegistration(
      clientMetadata,
      runtimeEnv.ALLOWED_CLIENT_REDIRECT_URIS,
      Number(request.headers.get("content-length")),
    ),
});

export default {
  async fetch(request: Request, env: WorkerEnv, context: ExecutionContext) {
    if (!isCanonicalMcpResource(env.MCP_CANONICAL_URL)) {
      return new Response("Invalid server configuration", {
        status: 500,
        headers: { "Cache-Control": "no-store" },
      });
    }
    const requestUrl = new URL(request.url);
    if (requestUrl.origin !== new URL(env.MCP_CANONICAL_URL).origin) {
      return new Response("Misdirected request", {
        status: 421,
        headers: { "Cache-Control": "no-store" },
      });
    }
    const pathname = requestUrl.pathname;
    if (request.method === "POST" && pathname === "/oauth/register") {
      const prepared = await prepareClientRegistrationRequest(request);
      if (prepared instanceof Response) return prepared;
      request = prepared;
    }
    if (request.method === "POST" && pathname === "/oauth/token") {
      const prepared = await prepareOAuthTokenRequest(request);
      if (prepared instanceof Response) return prepared;
      request = prepared;
    }
    return oauthProvider.fetch(request, env, context);
  },
} satisfies Pick<Required<ExportedHandler<WorkerEnv>>, "fetch">;
