import { describe, expect, it } from "vitest";
import {
  projectAgreementAddition,
  summarizeAgreementAdditions,
} from "../src/connectwise-business-tools";

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
});
