import { describe, expect, it } from "vitest";
import { renderConsentPage } from "../src/consent";

describe("renderConsentPage", () => {
  it("escapes untrusted client metadata and emits restrictive browser headers", async () => {
    const response = renderConsentPage({
      clientName: '<img src=x onerror="alert(1)">',
      scopes: ["mcp:read", "<script>alert(1)</script>"],
      signedState: "signed-state",
      csrfToken: "csrf-token",
    });

    const html = await response.text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "default-src 'none'",
    );
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});
