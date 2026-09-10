import { describe, expect, it } from "vitest";
import {
  AuthorizationPolicyError,
  resolveCredentialProfile,
} from "../src/auth-policy";

const config = {
  tenantId: "tenant-a",
  identityProfileMap: JSON.stringify({ "tenant-a:user-1": "LUIS" }),
  allowedGroupIds: JSON.stringify(["group-mcp-users"]),
  allowedAppRoles: JSON.stringify(["ConnectWise.Read"]),
};

describe("resolveCredentialProfile", () => {
  it("maps immutable tid and oid after group authorization", () => {
    const result = resolveCredentialProfile(
      {
        tid: "tenant-a",
        oid: "user-1",
        groups: ["group-mcp-users"],
      },
      config,
    );

    expect(result).toEqual({
      tenantId: "tenant-a",
      objectId: "user-1",
      profileAlias: "LUIS",
    });
  });

  it("authorizes an allowed app role when no group claim is present", () => {
    const result = resolveCredentialProfile(
      {
        tid: "tenant-a",
        oid: "user-1",
        roles: ["ConnectWise.Read"],
      },
      config,
    );

    expect(result.profileAlias).toBe("LUIS");
  });

  it("rejects a token from a different tenant", () => {
    expect(() =>
      resolveCredentialProfile(
        {
          tid: "tenant-b",
          oid: "user-1",
          groups: ["group-mcp-users"],
        },
        config,
      ),
    ).toThrowError(new AuthorizationPolicyError("wrong_tenant"));
  });

  it("rejects a caller without an allowed group or app role", () => {
    expect(() =>
      resolveCredentialProfile(
        { tid: "tenant-a", oid: "user-1", groups: ["other-group"] },
        config,
      ),
    ).toThrowError(new AuthorizationPolicyError("not_authorized"));
  });

  it("fails closed for an unmapped authorized identity", () => {
    expect(() =>
      resolveCredentialProfile(
        {
          tid: "tenant-a",
          oid: "user-2",
          groups: ["group-mcp-users"],
        },
        config,
      ),
    ).toThrowError(new AuthorizationPolicyError("unmapped_identity"));
  });

  it("rejects group-overage tokens instead of silently bypassing group policy", () => {
    expect(() =>
      resolveCredentialProfile(
        {
          tid: "tenant-a",
          oid: "user-1",
          hasgroups: true,
        },
        config,
      ),
    ).toThrowError(new AuthorizationPolicyError("group_overage"));
  });

  it("rejects array-valued identity mappings", () => {
    expect(() =>
      resolveCredentialProfile(
        {
          tid: "tenant-a",
          oid: "user-1",
          groups: ["group-mcp-users"],
        },
        {
          ...config,
          identityProfileMap: JSON.stringify({
            "tenant-a:user-1": ["LUIS"],
          }),
        },
      ),
    ).toThrowError(new AuthorizationPolicyError("invalid_configuration"));
  });

  it("rejects duplicate identity keys instead of accepting the last value", () => {
    expect(() =>
      resolveCredentialProfile(
        {
          tid: "tenant-a",
          oid: "user-1",
          groups: ["group-mcp-users"],
        },
        {
          ...config,
          identityProfileMap:
            '{"tenant-a:user-1":"FIRST","tenant-a:user-1":"SECOND"}',
        },
      ),
    ).toThrowError(new AuthorizationPolicyError("invalid_configuration"));
  });

  it("rejects duplicate identity keys with equivalent JSON escapes", () => {
    expect(() =>
      resolveCredentialProfile(
        {
          tid: "tenant-a",
          oid: "user-1",
          groups: ["group-mcp-users"],
        },
        {
          ...config,
          identityProfileMap:
            '{"tenant-a:user-1":"FIRST","tenant-a:user-\\u0031":"SECOND"}',
        },
      ),
    ).toThrowError(new AuthorizationPolicyError("invalid_configuration"));
  });

  it("rejects a profile alias shared by multiple identities", () => {
    expect(() =>
      resolveCredentialProfile(
        {
          tid: "tenant-a",
          oid: "user-1",
          groups: ["group-mcp-users"],
        },
        {
          ...config,
          identityProfileMap: JSON.stringify({
            "tenant-a:user-1": "LUIS",
            "tenant-a:user-2": "LUIS",
          }),
        },
      ),
    ).toThrowError(new AuthorizationPolicyError("invalid_configuration"));
  });

  it("fails closed when an unrelated mapping is invalid", () => {
    expect(() =>
      resolveCredentialProfile(
        {
          tid: "tenant-a",
          oid: "user-1",
          groups: ["group-mcp-users"],
        },
        {
          ...config,
          identityProfileMap: JSON.stringify({
            "tenant-a:user-1": "LUIS",
            "tenant-b:user-2": "OTHER",
          }),
        },
      ),
    ).toThrowError(new AuthorizationPolicyError("invalid_configuration"));
  });

  it("resolves every identity in a unique per-user map", () => {
    const identityProfileMap = JSON.stringify({
      "tenant-a:user-1": "USER_1",
      "tenant-a:user-2": "USER_2",
      "tenant-a:user-3": "USER_3",
      "tenant-a:user-4": "USER_4",
      "tenant-a:user-5": "USER_5",
      "tenant-a:user-6": "USER_6",
    });

    for (let user = 1; user <= 6; user += 1) {
      expect(
        resolveCredentialProfile(
          {
            tid: "tenant-a",
            oid: `user-${user}`,
            groups: ["group-mcp-users"],
          },
          { ...config, identityProfileMap },
        ).profileAlias,
      ).toBe(`USER_${user}`);
    }
  });
});
