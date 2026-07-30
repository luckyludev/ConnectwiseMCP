import { describe, expect, it } from "vitest";
import { getServiceTicketResult, whoamiResult } from "../src/mcp-server";

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

describe("get_service_ticket", () => {
  it("uses only the authenticated profile secret and allowlists output fields", async () => {
    const reads: string[] = [];
    const env = new Proxy(
      {
        CONNECTWISE_ALLOWED_ORIGINS: JSON.stringify([
          "https://api-na.myconnectwise.net",
        ]),
        CW_PROFILE_LUIS: JSON.stringify({
          apiBaseUrl: "https://api-na.myconnectwise.net/v4_6_release/apis/3.0",
          companyId: "acme",
          publicKey: "public-key",
          privateKey: "private-key",
          clientId: "partner-client-id",
        }),
        CW_PROFILE_OTHER: "must-not-be-read",
      },
      {
        get(target, property, receiver) {
          reads.push(String(property));
          return Reflect.get(target, property, receiver);
        },
      },
    );

    const result = await getServiceTicketResult(
      { profileAlias: "LUIS", scopes: ["mcp:read"] },
      env,
      123,
      {
        createClient: (selectedCredentials) => ({
          async getServiceTicket(ticketId) {
            expect(selectedCredentials.companyId).toBe("acme");
            expect(ticketId).toBe(123);
            return {
              id: 123,
              summary: "Printer offline",
              status: { name: "New" },
              privateUpstreamField: "must not escape",
            };
          },
        }),
      },
    );

    expect(result).toMatchObject({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            id: 123,
            summary: "Printer offline",
            status: "New",
          }),
        },
      ],
    });
    expect(reads).toEqual(["CONNECTWISE_ALLOWED_ORIGINS", "CW_PROFILE_LUIS"]);
  });

  it("returns a generic MCP error when the upstream client fails", async () => {
    const env = {
      CONNECTWISE_ALLOWED_ORIGINS: JSON.stringify([
        "https://api-na.myconnectwise.net",
      ]),
      CW_PROFILE_LUIS: JSON.stringify({
        apiBaseUrl: "https://api-na.myconnectwise.net/v4_6_release/apis/3.0",
        companyId: "acme",
        publicKey: "public-key",
        privateKey: "private-key",
        clientId: "partner-client-id",
      }),
    };

    const result = await getServiceTicketResult(
      { profileAlias: "LUIS", scopes: ["mcp:read"] },
      env,
      123,
      {
        createClient: () => ({
          async getServiceTicket() {
            throw new Error("upstream included credential=[REDACTED]");
          },
        }),
      },
    );

    expect(result).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "ConnectWise ticket lookup failed" }],
    });
    expect(JSON.stringify(result)).not.toContain("credential=");
  });

  it("rejects an oversized projected ticket field", async () => {
    const env = {
      CONNECTWISE_ALLOWED_ORIGINS: JSON.stringify([
        "https://api-na.myconnectwise.net",
      ]),
      CW_PROFILE_LUIS: JSON.stringify({
        apiBaseUrl: "https://api-na.myconnectwise.net/v4_6_release/apis/3.0",
        companyId: "acme",
        publicKey: "public-key",
        privateKey: "private-key",
        clientId: "partner-client-id",
      }),
    };

    const result = await getServiceTicketResult(
      { profileAlias: "LUIS", scopes: ["mcp:read"] },
      env,
      123,
      {
        createClient: () => ({
          async getServiceTicket() {
            return {
              id: 123,
              summary: "x".repeat(1_001),
              status: { name: "New" },
            };
          },
        }),
      },
    );

    expect(result).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "ConnectWise ticket lookup failed" }],
    });
  });

  it("accepts the exact projected ticket field boundaries", async () => {
    const env = {
      CONNECTWISE_ALLOWED_ORIGINS: JSON.stringify([
        "https://api-na.myconnectwise.net",
      ]),
      CW_PROFILE_LUIS: JSON.stringify({
        apiBaseUrl: "https://api-na.myconnectwise.net/v4_6_release/apis/3.0",
        companyId: "acme",
        publicKey: "public-key",
        privateKey: "private-key",
        clientId: "partner-client-id",
      }),
    };
    const result = await getServiceTicketResult(
      { profileAlias: "LUIS", scopes: ["mcp:read"] },
      env,
      123,
      {
        createClient: () => ({
          async getServiceTicket() {
            return {
              id: 123,
              summary: "s".repeat(1_000),
              status: { name: "n".repeat(100) },
            };
          },
        }),
      },
    );

    expect(result.isError).not.toBe(true);
  });

  it("rejects a status name above its exact boundary", async () => {
    const env = {
      CONNECTWISE_ALLOWED_ORIGINS: JSON.stringify([
        "https://api-na.myconnectwise.net",
      ]),
      CW_PROFILE_LUIS: JSON.stringify({
        apiBaseUrl: "https://api-na.myconnectwise.net/v4_6_release/apis/3.0",
        companyId: "acme",
        publicKey: "public-key",
        privateKey: "private-key",
        clientId: "partner-client-id",
      }),
    };
    const result = await getServiceTicketResult(
      { profileAlias: "LUIS", scopes: ["mcp:read"] },
      env,
      123,
      {
        createClient: () => ({
          async getServiceTicket() {
            return {
              id: 123,
              summary: "ok",
              status: { name: "n".repeat(101) },
            };
          },
        }),
      },
    );

    expect(result).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "ConnectWise ticket lookup failed" }],
    });
  });

  it("does not read secrets or construct a client without mcp:read", async () => {
    const reads: string[] = [];
    const env = new Proxy(
      { CW_PROFILE_LUIS: "must-not-be-read" },
      {
        get(target, property, receiver) {
          reads.push(String(property));
          return Reflect.get(target, property, receiver);
        },
      },
    );

    const result = await getServiceTicketResult(
      { profileAlias: "LUIS", scopes: [] },
      env,
      123,
      {
        createClient: () => {
          throw new Error("must not construct client");
        },
      },
    );

    expect(result).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "Insufficient scope" }],
    });
    expect(reads).toEqual([]);
  });

  it("constructs separate clients from separate authenticated profiles", async () => {
    const profile = (companyId: string) =>
      JSON.stringify({
        apiBaseUrl: "https://api-na.myconnectwise.net/v4_6_release/apis/3.0",
        companyId,
        publicKey: "public-key",
        privateKey: "private-key",
        clientId: "partner-client-id",
      });
    const env = {
      CONNECTWISE_ALLOWED_ORIGINS: JSON.stringify([
        "https://api-na.myconnectwise.net",
      ]),
      CW_PROFILE_LUIS: profile("company-luis"),
      CW_PROFILE_MAYA: profile("company-maya"),
    };
    const selectedCompanies: string[] = [];
    const createClient = (selectedCredentials: { companyId: string }) => {
      selectedCompanies.push(selectedCredentials.companyId);
      return {
        async getServiceTicket(ticketId: number) {
          return {
            id: ticketId,
            summary: selectedCredentials.companyId,
            status: { name: "New" },
          };
        },
      };
    };

    const luis = await getServiceTicketResult(
      { profileAlias: "LUIS", scopes: ["mcp:read"] },
      env,
      1,
      { createClient },
    );
    const maya = await getServiceTicketResult(
      { profileAlias: "MAYA", scopes: ["mcp:read"] },
      env,
      2,
      { createClient },
    );

    expect(selectedCompanies).toEqual(["company-luis", "company-maya"]);
    expect(JSON.stringify(luis)).toContain("company-luis");
    expect(JSON.stringify(luis)).not.toContain("company-maya");
    expect(JSON.stringify(maya)).toContain("company-maya");
    expect(JSON.stringify(maya)).not.toContain("company-luis");
  });
});
