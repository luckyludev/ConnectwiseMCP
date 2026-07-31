import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getServiceTicketResult, whoamiResult } from "../src/mcp-server";

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const tenantId = "11111111-1111-4111-8111-111111111111";
const objectId = "22222222-2222-4222-8222-222222222222";
const correlationId = "33333333-3333-4333-8333-333333333333";

describe("whoami", () => {
  it("returns the profile only with the request-scoped mcp:read scope", () => {
    const auditMessages: string[] = [];
    const times = [5_000, 5_002];
    expect(
      whoamiResult(
        {
          tenantId,
          objectId,
          profileAlias: "LUIS",
          scopes: ["mcp:read"],
        },
        {
          audit: {
            logger: (message) => auditMessages.push(message),
            now: () => times.shift()!,
            createCorrelationId: () => correlationId,
          },
        },
      ),
    ).toMatchObject({
      content: [
        { type: "text", text: JSON.stringify({ profileAlias: "LUIS" }) },
      ],
    });
    expect(JSON.parse(auditMessages[0]!)).toMatchObject({
      tool: "whoami",
      outcome: "success",
      reason: "ok",
      durationMs: 2,
      tenantId,
      objectId,
      profileAlias: "LUIS",
    });
  });

  it("does not let a failing audit clock alter the result", () => {
    expect(
      whoamiResult(
        {
          tenantId,
          objectId,
          profileAlias: "LUIS",
          scopes: ["mcp:read"],
        },
        {
          audit: {
            now: () => {
              throw new Error("audit clock unavailable");
            },
          },
        },
      ),
    ).toMatchObject({
      content: [
        { type: "text", text: JSON.stringify({ profileAlias: "LUIS" }) },
      ],
    });
  });

  it("audits a missing authenticated profile", () => {
    const auditMessages: string[] = [];
    const times = [7_000, 7_003];

    expect(
      whoamiResult(
        { tenantId, objectId, scopes: ["mcp:read"] },
        {
          audit: {
            logger: (message) => auditMessages.push(message),
            now: () => times.shift()!,
            createCorrelationId: () => correlationId,
          },
        },
      ),
    ).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "Authenticated profile unavailable" }],
    });
    expect(JSON.parse(auditMessages[0]!)).toMatchObject({
      tool: "whoami",
      outcome: "denied",
      reason: "profile_unavailable",
      durationMs: 3,
      tenantId,
      objectId,
    });
  });

  it.each([undefined, []])(
    "rejects missing or empty effective scopes",
    (scopes) => {
      const auditMessages: string[] = [];
      const times = [6_000, 6_001];
      const props = scopes
        ? { tenantId, objectId, profileAlias: "LUIS", scopes }
        : { tenantId, objectId, profileAlias: "LUIS" };
      expect(
        whoamiResult(props, {
          audit: {
            logger: (message) => auditMessages.push(message),
            now: () => times.shift()!,
            createCorrelationId: () => correlationId,
          },
        }),
      ).toMatchObject({
        isError: true,
        content: [{ type: "text", text: "Insufficient scope" }],
      });
      expect(JSON.parse(auditMessages[0]!)).toMatchObject({
        tool: "whoami",
        outcome: "denied",
        reason: "insufficient_scope",
        durationMs: 1,
        tenantId,
        objectId,
        profileAlias: "LUIS",
      });
      expect(auditMessages[0]!).not.toContain("scopes");
    },
  );
});

describe("get_service_ticket", () => {
  it("uses only the authenticated profile secret and excludes raw ticket text", async () => {
    const reads: string[] = [];
    const auditMessages: string[] = [];
    const times = [900, 1_000];
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
      {
        tenantId,
        objectId,
        profileAlias: "LUIS",
        scopes: ["mcp:read"],
      },
      env,
      123,
      {
        audit: {
          logger: (message) => auditMessages.push(message),
          now: () => times.shift()!,
          createCorrelationId: () => correlationId,
        },
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
            status: "New",
          }),
        },
      ],
    });
    expect(reads).toEqual(["CONNECTWISE_ALLOWED_ORIGINS", "CW_PROFILE_LUIS"]);
    expect(JSON.stringify(result)).not.toContain("Printer offline");
    expect(JSON.stringify(result)).not.toContain("privateUpstreamField");
    expect(auditMessages).toHaveLength(1);
    expect(JSON.parse(auditMessages[0]!)).toEqual({
      version: 1,
      event: "mcp_tool_invocation",
      timestamp: "1970-01-01T00:00:01.000Z",
      correlationId,
      tenantId,
      objectId,
      profileAlias: "LUIS",
      tool: "get_service_ticket",
      outcome: "success",
      reason: "ok",
      durationMs: 100,
    });
    expect(auditMessages[0]!).not.toContain("Printer offline");
    expect(auditMessages[0]!).not.toContain("privateUpstreamField");
  });

  it("returns a generic MCP error when the upstream client fails", async () => {
    const auditMessages: string[] = [];
    const times = [2_000, 2_050];
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
      {
        tenantId,
        objectId,
        profileAlias: "LUIS",
        scopes: ["mcp:read"],
      },
      env,
      123,
      {
        audit: {
          logger: (message) => auditMessages.push(message),
          now: () => times.shift()!,
          createCorrelationId: () => correlationId,
        },
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
    expect(auditMessages).toHaveLength(1);
    expect(JSON.parse(auditMessages[0]!)).toMatchObject({
      correlationId,
      tenantId,
      objectId,
      profileAlias: "LUIS",
      tool: "get_service_ticket",
      outcome: "failure",
      reason: "lookup_failed",
      durationMs: 50,
    });
    expect(auditMessages[0]!).not.toContain("credential=");
    expect(auditMessages[0]!).not.toContain("upstream included");
  });

  it("drops oversized upstream ticket text instead of returning it", async () => {
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
      content: [
        { type: "text", text: JSON.stringify({ id: 123, status: "New" }) },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("x".repeat(1_001));
  });

  it("accepts the exact status-name boundary", async () => {
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

  it("audits a missing authenticated profile before reading bindings", async () => {
    const reads: string[] = [];
    const auditMessages: string[] = [];
    const times = [4_000, 4_005];
    const env = new Proxy(
      {},
      {
        get(target, property, receiver) {
          reads.push(String(property));
          return Reflect.get(target, property, receiver);
        },
      },
    );

    const result = await getServiceTicketResult(
      { tenantId, objectId, scopes: ["mcp:read"] },
      env,
      123,
      {
        audit: {
          logger: (message) => auditMessages.push(message),
          now: () => times.shift()!,
          createCorrelationId: () => correlationId,
        },
        createClient: () => {
          throw new Error("must not construct client");
        },
      },
    );

    expect(result).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "Authenticated profile unavailable" }],
    });
    expect(reads).toEqual([]);
    expect(JSON.parse(auditMessages[0]!)).toMatchObject({
      outcome: "denied",
      reason: "profile_unavailable",
      durationMs: 5,
      tenantId,
      objectId,
    });
  });

  it("does not read secrets or construct a client without mcp:read", async () => {
    const reads: string[] = [];
    const auditMessages: string[] = [];
    const times = [3_000, 3_010];
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
      { tenantId, objectId, profileAlias: "LUIS", scopes: [] },
      env,
      123,
      {
        audit: {
          logger: (message) => auditMessages.push(message),
          now: () => times.shift()!,
          createCorrelationId: () => correlationId,
        },
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
    expect(auditMessages).toHaveLength(1);
    expect(JSON.parse(auditMessages[0]!)).toMatchObject({
      correlationId,
      tenantId,
      objectId,
      profileAlias: "LUIS",
      tool: "get_service_ticket",
      outcome: "denied",
      reason: "insufficient_scope",
      durationMs: 10,
    });
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
    expect(luis).toMatchObject({
      content: [
        { type: "text", text: JSON.stringify({ id: 1, status: "New" }) },
      ],
    });
    expect(maya).toMatchObject({
      content: [
        { type: "text", text: JSON.stringify({ id: 2, status: "New" }) },
      ],
    });
    expect(JSON.stringify(luis)).not.toContain("company-luis");
    expect(JSON.stringify(luis)).not.toContain("company-maya");
    expect(JSON.stringify(maya)).not.toContain("company-luis");
    expect(JSON.stringify(maya)).not.toContain("company-maya");
  });
});
