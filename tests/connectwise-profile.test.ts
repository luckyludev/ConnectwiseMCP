import { describe, expect, it } from "vitest";
import {
  resolveConnectWiseCredentials,
  resolveIdentityBoundConnectWiseCredentials,
} from "../src/connectwise-profile";

describe("resolveConnectWiseCredentials", () => {
  it("reads only the selected profile secret", () => {
    const reads: string[] = [];
    const secret = JSON.stringify({
      apiBaseUrl: "https://api-na.myconnectwise.net/v4_6_release/apis/3.0",
      companyId: "acme",
      publicKey: "public-key",
      privateKey: "private-key",
      clientId: "partner-client-id",
    });
    const env = new Proxy(
      {
        CONNECTWISE_ALLOWED_ORIGINS: JSON.stringify([
          "https://api-na.myconnectwise.net",
        ]),
        CW_PROFILE_LUIS: secret,
        CW_PROFILE_OTHER: "must-not-be-read",
      },
      {
        get(target, property, receiver) {
          reads.push(String(property));
          return Reflect.get(target, property, receiver);
        },
      },
    );

    expect(resolveConnectWiseCredentials(env, "LUIS")).toEqual({
      apiBaseUrl: "https://api-na.myconnectwise.net/v4_6_release/apis/3.0",
      companyId: "acme",
      publicKey: "public-key",
      privateKey: "private-key",
      clientId: "partner-client-id",
    });
    expect(reads).toEqual(["CONNECTWISE_ALLOWED_ORIGINS", "CW_PROFILE_LUIS"]);
  });

  it("rejects an invalid profile alias before reading environment bindings", () => {
    const reads: string[] = [];
    const env = new Proxy(
      {},
      {
        get(target, property, receiver) {
          reads.push(String(property));
          return Reflect.get(target, property, receiver);
        },
      },
    );

    expect(() => resolveConnectWiseCredentials(env, "../OTHER")).toThrow(
      "Invalid ConnectWise profile alias",
    );
    expect(reads).toEqual([]);
  });

  it.each([
    "https://127.0.0.1",
    "https://169.254.169.254",
    "https://[::1]",
    "https://localhost",
    "https://localhost.",
    "https://connectwise.local",
    "https://connectwise.local.",
    "https://api-na.myconnectwise.net.",
    "https://api-na.myconnectwise.net/path",
    "https://user@api-na.myconnectwise.net",
  ])("rejects unsafe allowed origin %s", (origin) => {
    const env = {
      CONNECTWISE_ALLOWED_ORIGINS: JSON.stringify([origin]),
      CW_PROFILE_LUIS: JSON.stringify({
        apiBaseUrl: "https://api-na.myconnectwise.net/v4_6_release/apis/3.0",
        companyId: "acme",
        publicKey: "public-key",
        privateKey: "private-key",
        clientId: "partner-client-id",
      }),
    };

    expect(() => resolveConnectWiseCredentials(env, "LUIS")).toThrow(
      "Invalid ConnectWise origin allowlist",
    );
  });

  it("rejects an incomplete profile secret", () => {
    const env = {
      CONNECTWISE_ALLOWED_ORIGINS: JSON.stringify([
        "https://api-na.myconnectwise.net",
      ]),
      CW_PROFILE_LUIS: JSON.stringify({
        apiBaseUrl: "https://api-na.myconnectwise.net/v4_6_release/apis/3.0",
        companyId: "acme",
        publicKey: "public-key",
        privateKey: "private-key",
      }),
    };

    expect(() => resolveConnectWiseCredentials(env, "LUIS")).toThrow(
      "ConnectWise profile configuration failed validation",
    );
  });

  it("rejects a non-HTTPS API base URL", () => {
    const env = {
      CONNECTWISE_ALLOWED_ORIGINS: JSON.stringify([
        "https://api-na.myconnectwise.net",
      ]),
      CW_PROFILE_LUIS: JSON.stringify({
        apiBaseUrl: "http://api-na.myconnectwise.net/v4_6_release/apis/3.0",
        companyId: "acme",
        publicKey: "public-key",
        privateKey: "private-key",
        clientId: "partner-client-id",
      }),
    };

    expect(() => resolveConnectWiseCredentials(env, "LUIS")).toThrow(
      "ConnectWise profile configuration failed validation",
    );
  });

  it("rejects an API base URL containing embedded credentials", () => {
    const env = {
      CONNECTWISE_ALLOWED_ORIGINS: JSON.stringify([
        "https://api-na.myconnectwise.net",
      ]),
      CW_PROFILE_LUIS: JSON.stringify({
        apiBaseUrl:
          "https://user@api-na.myconnectwise.net/v4_6_release/apis/3.0",
        companyId: "acme",
        publicKey: "public-key",
        privateKey: "private-key",
        clientId: "partner-client-id",
      }),
    };

    expect(() => resolveConnectWiseCredentials(env, "LUIS")).toThrow(
      "ConnectWise profile configuration failed validation",
    );
  });

  it("rejects a non-canonical API base URL", () => {
    const env = {
      CONNECTWISE_ALLOWED_ORIGINS: JSON.stringify([
        "https://api-na.myconnectwise.net",
      ]),
      CW_PROFILE_LUIS: JSON.stringify({
        apiBaseUrl:
          "https://api-na.myconnectwise.net:443/v4_6_release/apis/3.0",
        companyId: "acme",
        publicKey: "public-key",
        privateKey: "private-key",
        clientId: "partner-client-id",
      }),
    };

    expect(() => resolveConnectWiseCredentials(env, "LUIS")).toThrow(
      "ConnectWise profile configuration failed validation",
    );
  });

  it("rejects an API URL outside the ConnectWise REST base path", () => {
    const env = {
      CONNECTWISE_ALLOWED_ORIGINS: JSON.stringify([
        "https://api-na.myconnectwise.net",
      ]),
      CW_PROFILE_LUIS: JSON.stringify({
        apiBaseUrl: "https://api-na.myconnectwise.net/not-connectwise",
        companyId: "acme",
        publicKey: "public-key",
        privateKey: "private-key",
        clientId: "partner-client-id",
      }),
    };

    expect(() => resolveConnectWiseCredentials(env, "LUIS")).toThrow(
      "ConnectWise profile configuration failed validation",
    );
  });

  it("rejects an API origin outside the deployment allowlist", () => {
    const env = {
      CONNECTWISE_ALLOWED_ORIGINS: JSON.stringify([
        "https://api-na.myconnectwise.net",
      ]),
      CW_PROFILE_LUIS: JSON.stringify({
        apiBaseUrl: "https://evil.example/v4_6_release/apis/3.0",
        companyId: "acme",
        publicKey: "public-key",
        privateKey: "private-key",
        clientId: "partner-client-id",
      }),
    };

    expect(() => resolveConnectWiseCredentials(env, "LUIS")).toThrow(
      "ConnectWise profile origin not allowed (profile origin: https://evil.example; allowlist entries: 1)",
    );
  });

  it("rejects query parameters in the API base URL", () => {
    const env = {
      CONNECTWISE_ALLOWED_ORIGINS: JSON.stringify([
        "https://api-na.myconnectwise.net",
      ]),
      CW_PROFILE_LUIS: JSON.stringify({
        apiBaseUrl:
          "https://api-na.myconnectwise.net/v4_6_release/apis/3.0?x=1",
        companyId: "acme",
        publicKey: "public-key",
        privateKey: "private-key",
        clientId: "partner-client-id",
      }),
    };

    expect(() => resolveConnectWiseCredentials(env, "LUIS")).toThrow(
      "ConnectWise profile configuration failed validation",
    );
  });

  it("rejects control characters in a header credential", () => {
    const env = {
      CONNECTWISE_ALLOWED_ORIGINS: JSON.stringify([
        "https://api-na.myconnectwise.net",
      ]),
      CW_PROFILE_LUIS: JSON.stringify({
        apiBaseUrl: "https://api-na.myconnectwise.net/v4_6_release/apis/3.0",
        companyId: "acme",
        publicKey: "public-key",
        privateKey: "private-key",
        clientId: "partner-client-id\r\nInjected: value",
      }),
    };

    expect(() => resolveConnectWiseCredentials(env, "LUIS")).toThrow(
      "ConnectWise profile configuration failed validation",
    );
  });

  it("rejects non-ASCII Basic-auth credentials", () => {
    const env = {
      CONNECTWISE_ALLOWED_ORIGINS: JSON.stringify([
        "https://api-na.myconnectwise.net",
      ]),
      CW_PROFILE_LUIS: JSON.stringify({
        apiBaseUrl: "https://api-na.myconnectwise.net/v4_6_release/apis/3.0",
        companyId: "acme",
        publicKey: "públic-key",
        privateKey: "private-key",
        clientId: "partner-client-id",
      }),
    };

    expect(() => resolveConnectWiseCredentials(env, "LUIS")).toThrow(
      "ConnectWise profile configuration failed validation",
    );
  });
});

describe("resolveIdentityBoundConnectWiseCredentials", () => {
  const tenantId = "11111111-1111-4111-8111-111111111111";
  const objectId = "22222222-2222-4222-8222-222222222222";
  const groupId = "33333333-3333-4333-8333-333333333333";
  const secret = JSON.stringify({
    apiBaseUrl: "https://api-na.myconnectwise.net/v4_6_release/apis/3.0",
    companyId: "acme",
    publicKey: "public-key",
    privateKey: "private-key",
    clientId: "partner-client-id",
  });

  function trackedEnv(overrides: Record<string, unknown> = {}) {
    const reads: string[] = [];
    const env = new Proxy(
      {
        ENTRA_TENANT_ID: tenantId,
        IDENTITY_PROFILE_MAP: JSON.stringify({
          [`${tenantId}:${objectId}`]: "LUIS",
        }),
        ALLOWED_GROUP_IDS: JSON.stringify([groupId]),
        ALLOWED_APP_ROLES: "[]",
        CONNECTWISE_ALLOWED_ORIGINS: JSON.stringify([
          "https://api-na.myconnectwise.net",
        ]),
        CW_PROFILE_LUIS: secret,
        CW_PROFILE_MAYA: "must-not-be-read",
        ...overrides,
      },
      {
        get(target, property, receiver) {
          reads.push(String(property));
          return Reflect.get(target, property, receiver);
        },
      },
    );
    return { env, reads };
  }

  const props = {
    tenantId,
    objectId,
    profileAlias: "LUIS",
    groups: [groupId],
    roles: [],
  };

  it("revalidates the exact identity mapping before reading one selected profile", () => {
    const { env, reads } = trackedEnv();

    expect(
      resolveIdentityBoundConnectWiseCredentials(env, props),
    ).toMatchObject({
      companyId: "acme",
    });
    expect(reads).toEqual([
      "ENTRA_TENANT_ID",
      "IDENTITY_PROFILE_MAP",
      "ALLOWED_GROUP_IDS",
      "ALLOWED_APP_ROLES",
      "CONNECTWISE_ALLOWED_ORIGINS",
      "CW_PROFILE_LUIS",
    ]);
  });

  it.each([
    ["removed mapping", { IDENTITY_PROFILE_MAP: "{}" }],
    [
      "remapped identity",
      {
        IDENTITY_PROFILE_MAP: JSON.stringify({
          [`${tenantId}:${objectId}`]: "MAYA",
        }),
      },
    ],
    ["revoked eligibility", { ALLOWED_GROUP_IDS: "[]" }],
  ])(
    "fails closed for %s before reading credential bindings",
    (_name, overrides) => {
      const { env, reads } = trackedEnv(overrides);

      expect(() =>
        resolveIdentityBoundConnectWiseCredentials(env, props),
      ).toThrow();
      expect(reads).toEqual([
        "ENTRA_TENANT_ID",
        "IDENTITY_PROFILE_MAP",
        "ALLOWED_GROUP_IDS",
        "ALLOWED_APP_ROLES",
      ]);
      expect(reads).not.toContain("CONNECTWISE_ALLOWED_ORIGINS");
      expect(reads.every((binding) => !binding.startsWith("CW_PROFILE_"))).toBe(
        true,
      );
    },
  );

  it("rejects incomplete token identity before reading any binding", () => {
    const { env, reads } = trackedEnv();

    expect(() =>
      resolveIdentityBoundConnectWiseCredentials(env, {
        profileAlias: "LUIS",
        groups: [groupId],
      }),
    ).toThrow("Authenticated ConnectWise profile binding unavailable");
    expect(reads).toEqual([]);
  });
});
