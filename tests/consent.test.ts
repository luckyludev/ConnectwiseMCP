import { describe, expect, it } from "vitest";
import { renderConsentPage } from "../src/consent";

describe("renderConsentPage", () => {
  it("escapes untrusted client metadata and emits restrictive browser headers", async () => {
    const response = renderConsentPage({
      clientName: '<img src=x onerror="alert(1)">',
      scopes: ["mcp:read", "<script>alert(1)</script>"],
      signedState: "signed-state",
      csrfToken: "csrf-token",
      origin: "https://mcp.example.com",
      clientRedirectUri: "https://client.example.com/oauth/callback",
    });

    const html = await response.text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(response.headers.get("Content-Security-Policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://mcp.example.com https://login.microsoftonline.com https://client.example.com; base-uri 'none'; frame-ancestors 'none'",
    );
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("serializes only safe HTTPS or loopback origins into form-action", () => {
    const baseOptions = {
      clientName: "Local MCP Client",
      scopes: ["mcp:read"],
      signedState: "signed-state",
      csrfToken: "csrf-token",
      origin: "https://mcp.example.com",
    };

    const loopback = renderConsentPage({
      ...baseOptions,
      clientRedirectUri: "http://127.0.0.1:49152/oauth/callback",
    });
    expect(loopback.headers.get("Content-Security-Policy")).toContain(
      "http://127.0.0.1:49152",
    );

    expect(() =>
      renderConsentPage({
        ...baseOptions,
        clientRedirectUri: "http://attacker.example/oauth/callback",
      }),
    ).toThrow("Invalid form-action origin");
    const pathMetacharacters = renderConsentPage({
      ...baseOptions,
      clientRedirectUri:
        "https://client.example.com/oauth/callback; form-action *",
    });
    expect(
      pathMetacharacters.headers.get("Content-Security-Policy"),
    ).not.toContain("form-action *");
  });
});
