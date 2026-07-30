import { describe, expect, it } from "vitest";
import { validateClientRegistration } from "../src/client-registration";

describe("validateClientRegistration", () => {
  it("allows only exact configured HTTPS redirect URIs", () => {
    expect(
      validateClientRegistration(
        { redirect_uris: ["https://chatgpt.com/connector/callback"] },
        JSON.stringify(["https://chatgpt.com/connector/callback"]),
      ),
    ).toBeUndefined();

    expect(
      validateClientRegistration(
        { redirect_uris: ["https://attacker.example/callback"] },
        JSON.stringify(["https://chatgpt.com/connector/callback"]),
      ),
    ).toMatchObject({ code: "invalid_redirect_uri", status: 400 });

    expect(
      validateClientRegistration(
        { redirect_uris: ["http://chatgpt.com/callback"] },
        JSON.stringify(["https://chatgpt.com/connector/callback"]),
      ),
    ).toMatchObject({ code: "invalid_redirect_uri", status: 400 });

    expect(
      validateClientRegistration(
        { redirect_uris: ["https://chatgpt.com/unapproved/callback"] },
        JSON.stringify(["https://chatgpt.com/connector/callback"]),
      ),
    ).toMatchObject({ code: "invalid_redirect_uri", status: 400 });

    expect(
      validateClientRegistration(
        { redirect_uris: ["https://chatgpt.com/connector/callback?other=1"] },
        JSON.stringify(["https://chatgpt.com/connector/callback"]),
      ),
    ).toMatchObject({ code: "invalid_redirect_uri", status: 400 });

    expect(
      validateClientRegistration(
        { redirect_uris: ["https://chatgpt.com:8443/connector/callback"] },
        JSON.stringify(["https://chatgpt.com/connector/callback"]),
      ),
    ).toMatchObject({ code: "invalid_redirect_uri", status: 400 });

    expect(
      validateClientRegistration(
        { redirect_uris: ["https://chatgpt.com:443/connector/callback"] },
        JSON.stringify(["https://chatgpt.com/connector/callback"]),
      ),
    ).toMatchObject({ code: "invalid_redirect_uri", status: 400 });

    expect(
      validateClientRegistration(
        { redirect_uris: ["https://chatgpt.com/a/../connector/callback"] },
        JSON.stringify(["https://chatgpt.com/connector/callback"]),
      ),
    ).toMatchObject({ code: "invalid_redirect_uri", status: 400 });
  });

  it("permits only loopback port variance for an exact configured callback", () => {
    expect(
      validateClientRegistration(
        { redirect_uris: ["http://127.0.0.1:49152/callback"] },
        JSON.stringify(["http://127.0.0.1/callback"]),
      ),
    ).toBeUndefined();

    expect(
      validateClientRegistration(
        { redirect_uris: ["http://127.0.0.1:49152/other"] },
        JSON.stringify(["http://127.0.0.1/callback"]),
      ),
    ).toMatchObject({ code: "invalid_redirect_uri", status: 400 });

    expect(
      validateClientRegistration(
        { redirect_uris: ["http://127.0.0.1:49152/a/../callback"] },
        JSON.stringify(["http://127.0.0.1/callback"]),
      ),
    ).toMatchObject({ code: "invalid_redirect_uri", status: 400 });

    expect(
      validateClientRegistration(
        { redirect_uris: ["http://localhost:49152/callback"] },
        JSON.stringify(["http://127.0.0.1/callback"]),
      ),
    ).toMatchObject({ code: "invalid_redirect_uri", status: 400 });
  });
});
