import { describe, expect, it, vi } from "vitest";

const downstream = vi.hoisted(() => ({
  mcpHandler: vi.fn(),
  oauthProviderFetch: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: {
    MCP_CANONICAL_URL: "https://mcp.example.com/mcp",
    ALLOWED_CLIENT_REDIRECT_URIS: "[]",
  },
}));

vi.mock("agents/mcp/server", () => ({
  createMcpHandler: () => downstream.mcpHandler,
}));

vi.mock("@cloudflare/workers-oauth-provider", () => ({
  default: class MockOAuthProvider {
    fetch(...args: unknown[]) {
      return downstream.oauthProviderFetch(...args);
    }
  },
}));

import worker from "../src/index";
import type { WorkerEnv } from "../src/auth-handler";

describe("Worker entrypoint configuration boundary", () => {
  it.each([
    ["GET", "/mcp"],
    ["POST", "/oauth/token"],
    ["POST", "/oauth/register"],
    ["GET", "/callback"],
    ["GET", "/.well-known/oauth-protected-resource/mcp"],
  ])(
    "rejects noncanonical configuration before downstream handling for %s %s",
    async (method, pathname) => {
      downstream.mcpHandler.mockClear();
      downstream.oauthProviderFetch.mockClear();
      const response = await worker.fetch(
        new Request(`https://worker.example${pathname}`, { method }),
        {
          MCP_CANONICAL_URL: "https://mcp.example.com/mcp?unsafe=true",
        } as WorkerEnv,
        {} as ExecutionContext,
      );

      expect(response.status).toBe(500);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).toBe("Invalid server configuration");
      expect(downstream.oauthProviderFetch).not.toHaveBeenCalled();
      expect(downstream.mcpHandler).not.toHaveBeenCalled();
    },
  );
});
