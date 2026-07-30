import { describe, expect, it } from "vitest";
import { emitToolAudit } from "../src/audit";

const tenantId = "11111111-1111-4111-8111-111111111111";
const objectId = "22222222-2222-4222-8222-222222222222";
const correlationId = "33333333-3333-4333-8333-333333333333";

describe("emitToolAudit", () => {
  it.each([
    {
      name: "malformed correlation ID",
      startedAtMs: 0,
      now: 1,
      correlation: "bad\nauthorization=secret",
    },
    {
      name: "non-finite start time",
      startedAtMs: Number.NaN,
      now: 1,
      correlation: correlationId,
    },
  ])("suppresses an event with $name", ({ startedAtMs, now, correlation }) => {
    const messages: string[] = [];

    expect(() =>
      emitToolAudit(
        {
          props: { tenantId, objectId, profileAlias: "LUIS" },
          tool: "get_service_ticket",
          outcome: "success",
          reason: "ok",
          startedAtMs,
        },
        {
          logger: (message) => messages.push(message),
          now: () => now,
          createCorrelationId: () => correlation,
        },
      ),
    ).not.toThrow();
    expect(messages).toEqual([]);
  });

  it("bounds the emitted duration", () => {
    const messages: string[] = [];

    emitToolAudit(
      {
        props: { tenantId, objectId, profileAlias: "LUIS" },
        tool: "get_service_ticket",
        outcome: "success",
        reason: "ok",
        startedAtMs: 0,
      },
      {
        logger: (message) => messages.push(message),
        now: () => 1_000_000,
        createCorrelationId: () => correlationId,
      },
    );

    expect(JSON.parse(messages[0]!).durationMs).toBe(300_000);
  });

  it("does not throw when the logger fails", () => {
    expect(() =>
      emitToolAudit(
        {
          props: { tenantId, objectId, profileAlias: "LUIS" },
          tool: "get_service_ticket",
          outcome: "failure",
          reason: "lookup_failed",
          startedAtMs: 1_000,
        },
        {
          logger: () => {
            throw new Error("logging backend unavailable");
          },
          now: () => 1_001,
          createCorrelationId: () => correlationId,
        },
      ),
    ).not.toThrow();
  });

  it("omits malformed identity and profile fields", () => {
    const messages: string[] = [];

    emitToolAudit(
      {
        props: {
          tenantId: "tenant\nauthorization=secret",
          objectId: "not-an-object-id",
          profileAlias: "../OTHER",
        },
        tool: "get_service_ticket",
        outcome: "denied",
        reason: "insufficient_scope",
        startedAtMs: 1_000,
      },
      {
        logger: (message) => messages.push(message),
        now: () => 1_001,
        createCorrelationId: () => correlationId,
      },
    );

    const event = JSON.parse(messages[0]!);
    expect(event).not.toHaveProperty("tenantId");
    expect(event).not.toHaveProperty("objectId");
    expect(event).not.toHaveProperty("profileAlias");
    expect(messages[0]!).not.toContain("authorization");
    expect(messages[0]!).not.toContain("../OTHER");
  });

  it("emits only the allowlisted structured fields", () => {
    const messages: string[] = [];

    emitToolAudit(
      {
        props: {
          tenantId,
          objectId,
          profileAlias: "LUIS",
          scopes: ["mcp:read"],
          upstreamRefreshToken: "must-not-be-logged",
          authorization: "Basic must-not-be-logged",
        },
        tool: "get_service_ticket",
        outcome: "success",
        reason: "ok",
        startedAtMs: 900,
      },
      {
        logger: (message) => messages.push(message),
        now: () => 1_000,
        createCorrelationId: () => correlationId,
      },
    );

    expect(messages).toHaveLength(1);
    expect(JSON.parse(messages[0]!)).toEqual({
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
    expect(messages[0]!).not.toContain("must-not-be-logged");
    expect(messages[0]!).not.toContain("scopes");
    expect(messages[0]!).not.toContain("authorization");
  });
});
