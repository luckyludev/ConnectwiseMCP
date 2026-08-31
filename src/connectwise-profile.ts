import { z } from "zod";

function isApprovedConnectWiseOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const isIpLiteral =
      /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) ||
      (hostname.startsWith("[") && hostname.endsWith("]"));
    return (
      url.protocol === "https:" &&
      url.origin === value &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      !isIpLiteral &&
      hostname !== "localhost" &&
      !hostname.endsWith(".localhost") &&
      !hostname.endsWith(".local")
    );
  } catch {
    return false;
  }
}

const allowedOriginsSchema = z
  .array(z.string().refine(isApprovedConnectWiseOrigin))
  .min(1)
  .max(20)
  .refine((origins) => new Set(origins).size === origins.length);

const credentialValue = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[\x20-\x7E]+$/)
  .refine((value) => value === value.trim());

const credentialsSchema = z
  .object({
    apiBaseUrl: z
      .string()
      .min(1)
      .refine((value) => {
        try {
          const url = new URL(value);
          return (
            url.protocol === "https:" &&
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash &&
            url.pathname === "/v4_6_release/apis/3.0" &&
            url.href === value
          );
        } catch {
          return false;
        }
      }),
    companyId: credentialValue,
    publicKey: credentialValue,
    privateKey: credentialValue,
    clientId: credentialValue,
    // CW member ID for this user (enables get_my_member via
    // /system/members/{id}; the legacy /system/myMember route 404s).
    memberId: z.number().int().positive().max(1_000_000).optional(),
  })
  .strict();

export type ConnectWiseCredentials = z.infer<typeof credentialsSchema>;

export function resolveConnectWiseCredentials(
  env: object,
  profileAlias: string,
): ConnectWiseCredentials {
  if (!/^[A-Z][A-Z0-9_]{0,31}$/.test(profileAlias)) {
    throw new Error("Invalid ConnectWise profile alias");
  }
  const bindings = env as Record<string, unknown>;
  const rawAllowedOrigins = bindings.CONNECTWISE_ALLOWED_ORIGINS;
  let allowedOrigins: string[];
  try {
    if (typeof rawAllowedOrigins !== "string") throw new Error();
    allowedOrigins = allowedOriginsSchema.parse(JSON.parse(rawAllowedOrigins));
  } catch {
    throw new Error("Invalid ConnectWise origin allowlist");
  }

  const raw = bindings[`CW_PROFILE_${profileAlias}`];
  if (typeof raw !== "string") {
    throw new Error(
      `ConnectWise profile configuration unavailable (binding CW_PROFILE_${profileAlias} is missing or not a string)`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("ConnectWise profile configuration is not valid JSON");
  }
  try {
    const credentials = credentialsSchema.parse(parsed);
    const profileOrigin = new URL(credentials.apiBaseUrl).origin;
    if (!allowedOrigins.includes(profileOrigin)) {
      throw new Error(
        `ConnectWise profile origin not allowed (profile origin: ${profileOrigin}; allowlist entries: ${allowedOrigins.length})`,
      );
    }
    return credentials;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("ConnectWise profile origin not allowed")
    ) {
      throw error;
    }
    const issue = (
      error as { issues?: Array<{ path?: Array<string | number> }> }
    )?.issues?.[0];
    const issuePath = issue?.path?.length
      ? ` (field: ${issue.path.join(".")})`
      : "";
    throw new Error(
      `ConnectWise profile configuration failed validation${issuePath}`,
    );
  }
}
