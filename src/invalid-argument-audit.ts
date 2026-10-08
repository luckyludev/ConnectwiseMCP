import { z } from "zod";
import {
  emitToolAudit,
  getAuditStartTime,
  isToolAuditName,
  type ToolAuditDependencies,
} from "./audit";

interface StandardValidationResult {
  readonly value?: unknown | undefined;
  readonly issues?: readonly unknown[] | undefined;
}

type JsonSchemaOptions = {
  readonly target: string;
  readonly libraryOptions?: Record<string, unknown> | undefined;
};

interface StandardSchema {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    validate(
      value: unknown,
      options?: unknown,
    ): StandardValidationResult | Promise<StandardValidationResult>;
    readonly jsonSchema?:
      | {
          readonly input: (
            options: JsonSchemaOptions,
          ) => Record<string, unknown>;
          readonly output: (
            options: JsonSchemaOptions,
          ) => Record<string, unknown>;
        }
      | undefined;
  };
}

type ToolConfig = {
  readonly inputSchema?: unknown;
  readonly [key: string]: unknown;
};

type RegisterTool = (
  name: string,
  config: ToolConfig,
  callback: unknown,
) => unknown;

function isStandardSchema(value: unknown): value is StandardSchema {
  if ((typeof value !== "object" && typeof value !== "function") || !value) {
    return false;
  }
  const standard = (value as { readonly "~standard"?: unknown })["~standard"];
  return (
    typeof standard === "object" &&
    standard !== null &&
    typeof (standard as { readonly validate?: unknown }).validate === "function"
  );
}

function normalizeInputSchema(value: unknown): StandardSchema | undefined {
  if (value === undefined) return undefined;
  if (isStandardSchema(value)) return value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return z.object(value as Record<string, z.ZodType>);
}

function auditInvalidArguments(
  schema: StandardSchema,
  tool: string,
  props: unknown,
  dependencies: ToolAuditDependencies | undefined,
): StandardSchema {
  const standard = schema["~standard"];
  return {
    "~standard": {
      ...standard,
      async validate(
        value: unknown,
        options?: unknown,
      ): Promise<StandardValidationResult> {
        const startedAtMs = getAuditStartTime(dependencies);
        const result = await standard.validate(value, options);
        if (
          result.issues &&
          result.issues.length > 0 &&
          isToolAuditName(tool)
        ) {
          emitToolAudit(
            {
              props,
              tool,
              outcome: "denied",
              reason: "invalid_arguments",
              startedAtMs,
            },
            dependencies,
          );
        }
        return result;
      },
    },
  };
}

/**
 * Wraps registered input schemas so calls rejected before a tool callback still
 * produce one secret-free audit event. Unknown tools remain the SDK's concern.
 */
export function installInvalidArgumentAudit(
  server: { registerTool: unknown },
  props: unknown,
  dependencies: ToolAuditDependencies | undefined,
): void {
  if (typeof server.registerTool !== "function") {
    throw new TypeError("MCP server registerTool is unavailable");
  }
  const original = (server.registerTool as RegisterTool).bind(server);
  server.registerTool = ((
    name: string,
    config: ToolConfig,
    callback: unknown,
  ): unknown => {
    const schema = normalizeInputSchema(config.inputSchema);
    return original(
      name,
      schema
        ? {
            ...config,
            inputSchema: auditInvalidArguments(
              schema,
              name,
              props,
              dependencies,
            ),
          }
        : config,
      callback,
    );
  }) as RegisterTool;
}
