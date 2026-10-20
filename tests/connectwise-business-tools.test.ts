import { describe, expect, it } from "vitest";
import {
  MAX_TOOL_OUTPUT_BYTES,
  attachmentUploaderResourceResult,
  boundedToolOutput,
  projectAgreementAddition,
  summarizeAgreementAdditions,
} from "../src/connectwise-business-tools";
import { MAX_DOWNLOAD_BYTES } from "../src/connectwise-client";

describe("agreement addition projection", () => {
  const upstreamAddition = {
    id: 17,
    product: { id: 8, name: "Managed service", identifier: "MSP" },
    quantity: 3,
    unitPrice: 25,
    unitCost: 10,
    extPrice: 75,
    effectiveDate: "2026-09-01T00:00:00Z",
    cancelledDate: null,
    billCustomer: "Billable",
    description: "Monthly service",
    internalNotes: "must not escape",
    extCost: 29,
  };

  it("maps ConnectWise field names to the narrow public result", () => {
    expect(projectAgreementAddition(upstreamAddition)).toEqual({
      id: 17,
      product: { id: 8, name: "Managed service" },
      quantity: 3,
      unitPrice: 25,
      unitCost: 10,
      extendedPrice: 75,
      extendedCost: 29,
      effectiveDate: "2026-09-01T00:00:00Z",
      billCustomer: "Billable",
      description: "Monthly service",
    });
  });

  it("totals authoritative extended price and cost without exposing records", () => {
    expect(
      summarizeAgreementAdditions([
        upstreamAddition,
        { extPrice: 12, extCost: 7 },
      ]),
    ).toEqual({ count: 2, totalExtendedPrice: 87, totalCost: 36 });
  });

  it.each([
    { additions: [{ extCost: 7 }] },
    { additions: [{ extPrice: 12, extCost: null }] },
    { additions: [{ extPrice: "12", extCost: 7 }] },
  ])(
    "rejects malformed commercial summary fields: $additions",
    ({ additions }) => {
      expect(() => summarizeAgreementAdditions(additions)).toThrow(
        "Invalid agreement addition summary commercial fields",
      );
    },
  );

  it("rejects non-finite aggregate totals", () => {
    expect(() =>
      summarizeAgreementAdditions([
        { extPrice: Number.MAX_VALUE, extCost: 1 },
        { extPrice: Number.MAX_VALUE, extCost: 1 },
      ]),
    ).toThrow("Agreement addition summary totals exceed numeric limits");
  });
});

describe("bounded tool output", () => {
  it("accepts the byte limit and rejects one byte above it", () => {
    expect(boundedToolOutput("é", 4)).toEqual({
      content: [{ type: "text", text: '"é"' }],
    });
    expect(() => boundedToolOutput("é", 3)).toThrow(
      "MCP tool output too large",
    );
  });

  it("keeps the maximum attachment payload within the output budget", () => {
    const maximumBase64Bytes = 4 * Math.ceil(MAX_DOWNLOAD_BYTES / 3);
    const metadataAllowance = MAX_TOOL_OUTPUT_BYTES - maximumBase64Bytes;

    expect(metadataAllowance).toBeGreaterThanOrEqual(100_000);
  });
});

const tenantId = "11111111-1111-4111-8111-111111111111";
const objectId = "22222222-2222-4222-8222-222222222222";
const groupId = "33333333-3333-4333-8333-333333333333";
const correlationId = "44444444-4444-4444-8444-444444444444";
const resourceProps = {
  tenantId,
  objectId,
  profileAlias: "LUIS",
  groups: [groupId],
  roles: [],
  scopes: ["mcp:read"],
};
const resourceEnv = {
  ENTRA_TENANT_ID: tenantId,
  IDENTITY_PROFILE_MAP: JSON.stringify({ [`${tenantId}:${objectId}`]: "LUIS" }),
  ALLOWED_GROUP_IDS: JSON.stringify([groupId]),
  ALLOWED_APP_ROLES: "[]",
};

describe("attachment uploader resource", () => {
  it("audits an authorized read without exposing resource content or auth data", () => {
    const messages: string[] = [];
    const times = [1_000, 1_004];

    const result = attachmentUploaderResourceResult(
      resourceProps,
      resourceEnv,
      {
        audit: {
          logger: (message) => messages.push(message),
          now: () => times.shift()!,
          createCorrelationId: () => correlationId,
        },
      },
    );

    expect(result.contents[0]).toMatchObject({
      uri: "ui://connectwise/attachment-uploader.html",
      mimeType: "text/html;profile=mcp-app",
    });
    expect(result.contents[0]?.text).toContain("Drop or paste an image here");
    expect(JSON.parse(messages[0]!)).toEqual({
      version: 1,
      event: "mcp_resource_read",
      timestamp: "1970-01-01T00:00:01.004Z",
      correlationId,
      tenantId,
      objectId,
      profileAlias: "LUIS",
      resource: "ui://connectwise/attachment-uploader.html",
      outcome: "success",
      reason: "ok",
      durationMs: 4,
    });
    expect(messages[0]!).not.toContain("Drop or paste an image here");
    expect(messages[0]!).not.toContain("scopes");
  });

  it("uses one immutable identity snapshot for authorization and audit", () => {
    const messages: string[] = [];
    const alternateTenantId = "55555555-5555-4555-8555-555555555555";
    const alternateObjectId = "66666666-6666-4666-8666-666666666666";
    let tenantReads = 0;
    let objectReads = 0;
    let profileReads = 0;
    const props = {
      scopes: ["mcp:read"],
      groups: [groupId],
      roles: [],
      get tenantId() {
        tenantReads += 1;
        return tenantReads === 1 ? tenantId : alternateTenantId;
      },
      get objectId() {
        objectReads += 1;
        return objectReads === 1 ? objectId : alternateObjectId;
      },
      get profileAlias() {
        profileReads += 1;
        return profileReads === 1 ? "LUIS" : "OTHER";
      },
    };

    attachmentUploaderResourceResult(props, resourceEnv, {
      audit: {
        logger: (message) => messages.push(message),
        now: () => 1_000,
        createCorrelationId: () => correlationId,
      },
    });

    expect({ tenantReads, objectReads, profileReads }).toEqual({
      tenantReads: 1,
      objectReads: 1,
      profileReads: 1,
    });
    expect(JSON.parse(messages[0]!)).toMatchObject({
      tenantId,
      objectId,
      profileAlias: "LUIS",
      outcome: "success",
    });
    expect(messages[0]!).not.toContain(alternateTenantId);
    expect(messages[0]!).not.toContain(alternateObjectId);
    expect(messages[0]!).not.toContain("OTHER");
  });

  it("checks mcp:read before identity metadata or environment access", () => {
    const identityReads: string[] = [];
    const environmentReads: string[] = [];
    const messages: string[] = [];
    const props = {
      scopes: [],
      get tenantId() {
        identityReads.push("tenantId");
        return tenantId;
      },
      get objectId() {
        identityReads.push("objectId");
        return objectId;
      },
      get profileAlias() {
        identityReads.push("profileAlias");
        return "LUIS";
      },
    };
    const env = new Proxy(resourceEnv, {
      get(target, property, receiver) {
        environmentReads.push(String(property));
        return Reflect.get(target, property, receiver);
      },
    });

    expect(() =>
      attachmentUploaderResourceResult(props, env, {
        audit: {
          logger: (message) => messages.push(message),
          now: () => 1_000,
          createCorrelationId: () => correlationId,
        },
      }),
    ).toThrow("Insufficient scope");
    expect(identityReads).toEqual([]);
    expect(environmentReads).toEqual([]);
    expect(JSON.parse(messages[0]!)).toMatchObject({
      event: "mcp_resource_read",
      outcome: "denied",
      reason: "insufficient_scope",
    });
    expect(messages[0]!).not.toContain(tenantId);
    expect(messages[0]!).not.toContain(objectId);
  });

  it("audits a stale identity mapping without reading a profile secret", () => {
    const reads: string[] = [];
    const messages: string[] = [];
    const env = new Proxy(
      {
        ...resourceEnv,
        IDENTITY_PROFILE_MAP: JSON.stringify({
          [`${tenantId}:${objectId}`]: "OTHER",
        }),
        CW_PROFILE_LUIS: "must-not-be-read",
        CW_PROFILE_OTHER: "must-not-be-read",
      },
      {
        get(target, property, receiver) {
          reads.push(String(property));
          return Reflect.get(target, property, receiver);
        },
      },
    );

    expect(() =>
      attachmentUploaderResourceResult(resourceProps, env, {
        audit: {
          logger: (message) => messages.push(message),
          now: () => 1_000,
          createCorrelationId: () => correlationId,
        },
      }),
    ).toThrow("Authenticated ConnectWise profile binding changed");
    expect(reads).toEqual([
      "ENTRA_TENANT_ID",
      "IDENTITY_PROFILE_MAP",
      "ALLOWED_GROUP_IDS",
      "ALLOWED_APP_ROLES",
    ]);
    expect(reads.every((binding) => !binding.startsWith("CW_PROFILE_"))).toBe(
      true,
    );
    expect(JSON.parse(messages[0]!)).toMatchObject({
      event: "mcp_resource_read",
      tenantId,
      objectId,
      profileAlias: "LUIS",
      outcome: "denied",
      reason: "profile_unavailable",
    });
  });
});
