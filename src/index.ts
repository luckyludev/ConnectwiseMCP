import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { env as cloudflareEnv } from "cloudflare:workers";
import {
  createEntraAuthHandler,
  createTokenExchangeCallback,
  type WorkerEnv,
} from "./auth-handler";
import { validateClientRegistration } from "./client-registration";
import { createMcpServer } from "./mcp-server";

const runtimeEnv = cloudflareEnv as unknown as WorkerEnv;
const mcpHandler = createMcpHandler(() => createMcpServer(runtimeEnv), {
  route: "/mcp",
  corsOptions: false,
});

const apiHandler = {
  fetch(request: Request, env: WorkerEnv, context: ExecutionContext) {
    return mcpHandler(request, env, context);
  },
} satisfies Pick<Required<ExportedHandler<WorkerEnv>>, "fetch">;

export default new OAuthProvider({
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
  clientRegistrationCallback: ({ clientMetadata }) =>
    validateClientRegistration(
      clientMetadata,
      runtimeEnv.ALLOWED_CLIENT_REDIRECT_URIS,
    ),
});
