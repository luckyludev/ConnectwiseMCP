import { describe, expect, it } from "vitest";
import { resolveConnectWiseCredentials } from "../src/connectwise-profile";

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
    "https://connectwise.local",
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
