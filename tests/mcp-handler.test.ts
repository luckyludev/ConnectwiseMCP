import { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { createMcpHandler, getMcpAuthContext } from "../src/mcp-handler";

function request(body: Record<string, unknown>): Request {
  return new Request("https://mcp.example.com/mcp", {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2025-06-18",
    },
    body: JSON.stringify(body),
  });
}

function server(): McpServer {
  return new McpServer({ name: "test", version: "1.0.0" });
}

describe("MCP handler OAuth context adapter", () => {
  it("captures only verified per-request props while constructing the server", async () => {
    const observed: unknown[] = [];
    const handler = createMcpHandler(() => {
      observed.push(getMcpAuthContext()?.props);
      return server();
    });
    const props = {
      tenantId: "11111111-1111-4111-8111-111111111111",
      objectId: "22222222-2222-4222-8222-222222222222",
      profileAlias: "LUIS",
      scopes: ["mcp:read"],
    };

    const response = await handler(
      request({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      {},
      {
        props,
        auth: {
          token: "opaque-token",
          clientId: "approved-client",
          scope: ["mcp:read"],
          audience: "https://mcp.example.com/mcp",
          expiresAt: 1_800_000_000,
        },
      } as unknown as ExecutionContext,
    );

    expect(response.status).toBe(200);
    expect(observed).toEqual([props]);
    expect(getMcpAuthContext()).toBeUndefined();
    expect(await response.text()).not.toContain("opaque-token");
  });

  it("rejects mismatched host and browser origins before server construction", async () => {
    const factory = vi.fn(server);
    const handler = createMcpHandler(factory);

    const wrongHost = request({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });
    wrongHost.headers.set("host", "alternate.example");
    const hostResponse = await handler.fetch(wrongHost);

    const wrongOrigin = request({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    wrongOrigin.headers.set("origin", "https://alternate.example");
    const originResponse = await handler.fetch(wrongOrigin);

    expect(hostResponse.status).toBe(421);
    expect(hostResponse.headers.get("cache-control")).toBe("no-store");
    expect(originResponse.status).toBe(403);
    expect(originResponse.headers.get("cache-control")).toBe("no-store");
    expect(factory).not.toHaveBeenCalled();
  });

  it("accepts a same-origin browser request", async () => {
    const factory = vi.fn(server);
    const handler = createMcpHandler(factory);
    const sameOrigin = request({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });
    sameOrigin.headers.set("origin", "https://mcp.example.com");

    const response = await handler.fetch(sameOrigin);

    expect(response.status).toBe(200);
    expect(factory).toHaveBeenCalledOnce();
  });

  it("fails closed before constructing a server for malformed OAuth context", async () => {
    const factory = vi.fn(server);
    const handler = createMcpHandler(factory);

    const response = await handler(
      request({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      {},
      {
        props: { profileAlias: "LUIS" },
        auth: {
          token: "opaque-token",
          clientId: "approved-client",
          scope: "mcp:read",
        },
      } as unknown as ExecutionContext,
    );

    expect(response.status).toBe(500);
    expect(factory).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      error: { code: -32603, message: "Internal server error" },
      id: null,
    });
  });
});
