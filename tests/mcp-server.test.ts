import { describe, expect, it } from "vitest";
import { whoamiResult } from "../src/mcp-server";

describe("whoami", () => {
  it("returns the profile only with the request-scoped mcp:read scope", () => {
    expect(
      whoamiResult({ profileAlias: "LUIS", scopes: ["mcp:read"] }),
    ).toMatchObject({
      content: [
        { type: "text", text: JSON.stringify({ profileAlias: "LUIS" }) },
      ],
    });
  });

  it.each([undefined, []])(
    "rejects missing or empty effective scopes",
    (scopes) => {
      const props = scopes
        ? { profileAlias: "LUIS", scopes }
        : { profileAlias: "LUIS" };
      expect(whoamiResult(props)).toMatchObject({
        isError: true,
        content: [{ type: "text", text: "Insufficient scope" }],
      });
    },
  );
});
