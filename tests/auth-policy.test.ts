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

  it("rejects ambiguous identity mappings", () => {
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
            "tenant-a:user-1": ["LUIS", "ADMIN"],
          }),
        },
      ),
    ).toThrowError(new AuthorizationPolicyError("ambiguous_identity"));
  });
});
