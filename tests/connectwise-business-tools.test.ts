import { describe, expect, it } from "vitest";
import {
  MAX_TOOL_OUTPUT_BYTES,
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
