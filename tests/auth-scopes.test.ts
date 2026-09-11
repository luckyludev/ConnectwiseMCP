import { describe, expect, it } from "vitest";
import { hasMcpScopes } from "../src/auth-scopes";
import type { EntraAccessTokenProps } from "../src/auth-handler";

const asProps = (scopes: unknown) =>
  ({ scopes }) as Partial<EntraAccessTokenProps>;

describe("runtime MCP scope validation", () => {
  it("accepts only dense string arrays containing every required scope", () => {
    expect(hasMcpScopes(asProps(["mcp:read"]), ["mcp:read"])).toBe(true);
    expect(
      hasMcpScopes(asProps(["mcp:read", "mcp:write"]), [
        "mcp:read",
        "mcp:write",
      ]),
    ).toBe(true);
    expect(hasMcpScopes(asProps(["mcp:write"]), ["mcp:read"])).toBe(false);
  });

  it.each([undefined, null, "mcp:read", {}, ["mcp:read", 1]])(
    "fails closed for malformed scopes %#",
    (scopes) => {
      expect(hasMcpScopes(asProps(scopes), ["mcp:read"])).toBe(false);
    },
  );

  it("rejects sparse arrays and does not trust overridden array methods", () => {
    const sparse: unknown[] = [];
    sparse.length = 2;
    sparse[1] = "mcp:read";

    const overridden: unknown[] = [1];
    Object.defineProperties(overridden, {
      every: { value: () => true },
      includes: { value: () => true },
    });

    expect(hasMcpScopes(asProps(sparse), ["mcp:read"])).toBe(false);
    expect(hasMcpScopes(asProps(overridden), ["mcp:read"])).toBe(false);
  });

  it("snapshots each scope once before checking authorization", () => {
    let reads = 0;
    const stateful = new Proxy([1], {
      get(target, property, receiver) {
        if (property === "0") {
          reads += 1;
          return reads === 1 ? "not-a-scope" : "mcp:write";
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(hasMcpScopes(asProps(stateful), ["mcp:read", "mcp:write"])).toBe(
      false,
    );
    expect(reads).toBe(1);
  });

  it("fails closed without throwing when scope access throws", () => {
    const hostileProps = Object.defineProperty({}, "scopes", {
      get() {
        throw new Error("hostile scope accessor");
      },
    }) as Partial<EntraAccessTokenProps>;
    const hostileArray = new Proxy(["mcp:read"], {
      get(target, property, receiver) {
        if (property === "0") throw new Error("hostile array accessor");
        return Reflect.get(target, property, receiver);
      },
    });

    expect(hasMcpScopes(hostileProps, ["mcp:read"])).toBe(false);
    expect(hasMcpScopes(asProps(hostileArray), ["mcp:read"])).toBe(false);
  });
});
