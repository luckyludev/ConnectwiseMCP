import { describe, expect, it } from "vitest";
import { emitResourceAudit, emitToolAudit } from "../src/audit";

const tenantId = "11111111-1111-4111-8111-111111111111";
const objectId = "22222222-2222-4222-8222-222222222222";
const correlationId = "33333333-3333-4333-8333-333333333333";

const toolAuditResults = [
  ["success", "ok"],
  ["denied", "insufficient_scope"],
  ["denied", "profile_unavailable"],
  ["denied", "connectwise_denied"],
  ["denied", "invalid_arguments"],
  ["failure", "lookup_failed"],
  ["failure", "write_outcome_unknown"],
  ["failure", "operation_failed"],
] as const;
const toolAuditOutcomes = ["success", "denied", "failure"] as const;
const toolAuditReasons = [
  "ok",
  "insufficient_scope",
  "profile_unavailable",
  "lookup_failed",
  "connectwise_denied",
  "write_outcome_unknown",
  "operation_failed",
  "invalid_arguments",
] as const;
const allowedToolAuditResults = new Set(
  toolAuditResults.map(([outcome, reason]) => `${outcome}:${reason}`),
);
const invalidToolAuditResults = toolAuditOutcomes.flatMap((outcome) =>
  toolAuditReasons
    .filter((reason) => !allowedToolAuditResults.has(`${outcome}:${reason}`))
    .map((reason) => ({ outcome, reason })),
);

const resourceAuditResults = [
  ["success", "ok"],
  ["denied", "insufficient_scope"],
  ["denied", "profile_unavailable"],
] as const;
const resourceAuditOutcomes = ["success", "denied"] as const;
const resourceAuditReasons = [
  "ok",
  "insufficient_scope",
  "profile_unavailable",
] as const;
const allowedResourceAuditResults = new Set(
  resourceAuditResults.map(([outcome, reason]) => `${outcome}:${reason}`),
);
const invalidResourceAuditResults = resourceAuditOutcomes.flatMap((outcome) =>
  resourceAuditReasons
    .filter(
      (reason) => !allowedResourceAuditResults.has(`${outcome}:${reason}`),
    )
    .map((reason) => ({ outcome, reason })),
);

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

  it.each([
    {
      name: "tool name",
      field: "tool",
      value: "get_service_ticket\nauthorization=tool-secret",
    },
    {
      name: "outcome",
      field: "outcome",
      value: "success authorization=outcome-secret",
    },
    {
      name: "reason",
      field: "reason",
      value: "upstream response contained reason-secret",
    },
  ])("suppresses an event with an unrecognized $name", ({ field, value }) => {
    const messages: string[] = [];
    const input = {
      props: { tenantId, objectId, profileAlias: "LUIS" },
      tool: "get_service_ticket",
      outcome: "success",
      reason: "ok",
      startedAtMs: 0,
      [field]: value,
    };

    expect(() =>
      emitToolAudit(input as unknown as Parameters<typeof emitToolAudit>[0], {
        logger: (message) => messages.push(message),
        now: () => 1,
        createCorrelationId: () => correlationId,
      }),
    ).not.toThrow();
    expect(messages).toEqual([]);
  });

  it.each(invalidToolAuditResults)(
    "suppresses the invalid $outcome/$reason result pair",
    ({ outcome, reason }) => {
      const messages: string[] = [];

      emitToolAudit(
        {
          props: { tenantId, objectId, profileAlias: "LUIS" },
          tool: "get_service_ticket",
          outcome,
          reason,
          startedAtMs: 0,
        },
        {
          logger: (message) => messages.push(message),
          now: () => 1,
          createCorrelationId: () => correlationId,
        },
      );

      expect(messages).toEqual([]);
    },
  );

  it.each(toolAuditResults)(
    "emits the allowlisted %s/%s result pair",
    (outcome, reason) => {
      const messages: string[] = [];

      emitToolAudit(
        {
          props: { tenantId, objectId, profileAlias: "LUIS" },
          tool: "get_service_ticket",
          outcome,
          reason,
          startedAtMs: 0,
        },
        {
          logger: (message) => messages.push(message),
          now: () => 1,
          createCorrelationId: () => correlationId,
        },
      );

      expect(JSON.parse(messages[0]!)).toMatchObject({ outcome, reason });
    },
  );

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

  it("snapshots validated fields before serialization", () => {
    const messages: string[] = [];
    let toolReads = 0;
    let tenantReads = 0;
    const props = Object.defineProperty({}, "tenantId", {
      enumerable: true,
      get: () => (++tenantReads === 1 ? tenantId : "tenant-secret"),
    });
    const input = Object.defineProperties(
      {
        props,
        outcome: "success",
        reason: "ok",
        startedAtMs: 900,
      },
      {
        tool: {
          enumerable: true,
          get: () => (++toolReads === 1 ? "get_service_ticket" : "tool-secret"),
        },
      },
    );

    emitToolAudit(input as Parameters<typeof emitToolAudit>[0], {
      logger: (message) => messages.push(message),
      now: () => 1_000,
      createCorrelationId: () => correlationId,
    });

    expect(messages).toHaveLength(1);
    expect(JSON.parse(messages[0]!)).toMatchObject({
      tenantId,
      tool: "get_service_ticket",
    });
    expect(toolReads).toBe(1);
    expect(tenantReads).toBe(1);
    expect(messages[0]!).not.toContain("secret");
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

describe("emitResourceAudit", () => {
  it("emits only allowlisted resource-read fields", () => {
    const messages: string[] = [];

    emitResourceAudit(
      {
        props: {
          tenantId,
          objectId,
          profileAlias: "LUIS",
          scopes: ["mcp:read"],
          authorization: "Basic must-not-be-logged",
        },
        resource: "ui://connectwise/attachment-uploader.html",
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
      event: "mcp_resource_read",
      timestamp: "1970-01-01T00:00:01.000Z",
      correlationId,
      tenantId,
      objectId,
      profileAlias: "LUIS",
      resource: "ui://connectwise/attachment-uploader.html",
      outcome: "success",
      reason: "ok",
      durationMs: 100,
    });
    expect(messages[0]!).not.toContain("must-not-be-logged");
    expect(messages[0]!).not.toContain("scopes");
    expect(messages[0]!).not.toContain("authorization");
  });

  it("suppresses unrecognized resource identifiers and outcomes", () => {
    const messages: string[] = [];
    const base = {
      props: { tenantId, objectId, profileAlias: "LUIS" },
      resource: "ui://connectwise/attachment-uploader.html",
      outcome: "success",
      reason: "ok",
      startedAtMs: 0,
    };
    const dependencies = {
      logger: (message: string) => messages.push(message),
      now: () => 1,
      createCorrelationId: () => correlationId,
    };

    emitResourceAudit(
      {
        ...base,
        resource: "ui://attacker.example/secret",
      } as unknown as Parameters<typeof emitResourceAudit>[0],
      dependencies,
    );
    emitResourceAudit(
      { ...base, outcome: "failure" } as unknown as Parameters<
        typeof emitResourceAudit
      >[0],
      dependencies,
    );

    expect(messages).toEqual([]);
  });

  it.each(invalidResourceAuditResults)(
    "suppresses the invalid $outcome/$reason result pair",
    ({ outcome, reason }) => {
      const messages: string[] = [];

      emitResourceAudit(
        {
          props: { tenantId, objectId, profileAlias: "LUIS" },
          resource: "ui://connectwise/attachment-uploader.html",
          outcome,
          reason,
          startedAtMs: 0,
        },
        {
          logger: (message) => messages.push(message),
          now: () => 1,
          createCorrelationId: () => correlationId,
        },
      );

      expect(messages).toEqual([]);
    },
  );

  it.each(resourceAuditResults)(
    "emits the allowlisted %s/%s result pair",
    (outcome, reason) => {
      const messages: string[] = [];

      emitResourceAudit(
        {
          props: { tenantId, objectId, profileAlias: "LUIS" },
          resource: "ui://connectwise/attachment-uploader.html",
          outcome,
          reason,
          startedAtMs: 0,
        },
        {
          logger: (message) => messages.push(message),
          now: () => 1,
          createCorrelationId: () => correlationId,
        },
      );

      expect(JSON.parse(messages[0]!)).toMatchObject({ outcome, reason });
    },
  );

  it("does not throw when the resource audit logger fails", () => {
    expect(() =>
      emitResourceAudit(
        {
          props: { tenantId, objectId, profileAlias: "LUIS" },
          resource: "ui://connectwise/attachment-uploader.html",
          outcome: "success",
          reason: "ok",
          startedAtMs: 0,
        },
        {
          logger: () => {
            throw new Error("logging backend unavailable");
          },
          now: () => 1,
          createCorrelationId: () => correlationId,
        },
      ),
    ).not.toThrow();
  });
});
