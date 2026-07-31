import asyncio
import importlib.util
import logging
import os
import sys
import time
import types
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient


@pytest.fixture(scope="module")
def gateway_module():
    package = types.ModuleType("api_gateway")
    package.__path__ = []
    server = types.ModuleType("api_gateway.server")
    server.mcp = object()
    server.setup_config = lambda: None
    server.initialize_database = lambda: None
    server.initialize_fast_memory = lambda: None
    sys.modules["api_gateway"] = package
    sys.modules["api_gateway.server"] = server

    os.environ["SERVER_URL"] = "https://gateway.example.com"
    os.environ["MCP_RESOURCE_URL"] = "https://gateway.example.com"
    os.environ["JWT_SECRET_KEY"] = "x" * 32
    os.environ["MCP_STATIC_TOKEN"] = "s" * 32
    for name in ("AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET"):
        os.environ.pop(name, None)
    module_path = Path(__file__).parents[1] / "app" / "main.py"
    spec = importlib.util.spec_from_file_location("legacy_gateway_main", module_path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def client(gateway_module):
    gateway_module._clients.clear()
    gateway_module._auth_requests.clear()
    gateway_module._auth_codes.clear()
    return TestClient(gateway_module.app, raise_server_exceptions=False)


CALLBACK_URI = "https://client.example.com/callback"
RESOURCE_URI = "https://gateway.example.com"
PKCE_VERIFIER = "A" * 43


def register_client(client):
    response = client.post(
        "/oauth/register",
        json={
            "redirect_uris": [CALLBACK_URI],
            "client_name": "Test client",
            "token_endpoint_auth_method": "client_secret_post",
            "grant_types": ["authorization_code"],
            "response_types": ["code"],
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def seed_authorization_code(gateway_module):
    gateway_module._clients["test-client"] = {
        "client_id": "test-client",
        "client_secret": "unit-test-value",
        "redirect_uris": [CALLBACK_URI],
        "token_endpoint_auth_method": "client_secret_post",
        "grant_types": ["authorization_code"],
        "response_types": ["code"],
    }
    gateway_module._auth_codes["test-code"] = {
        "client_id": "test-client",
        "redirect_uri": CALLBACK_URI,
        "code_challenge": gateway_module._pkce_challenge(PKCE_VERIFIER),
        "code_challenge_method": "S256",
        "scope": "mcp:tools:read",
        "resource": RESOURCE_URI,
        "user_id": "test-user",
        "expires_at": gateway_module.time.time() + 600,
    }


def redeem_code(client, **overrides):
    data = {
        "grant_type": "authorization_code",
        "code": "test-code",
        "redirect_uri": CALLBACK_URI,
        "client_id": "test-client",
        "client_secret": "unit-test-value",
        "code_verifier": PKCE_VERIFIER,
        "resource": RESOURCE_URI,
    }
    for key, value in overrides.items():
        if value is None:
            data.pop(key, None)
        else:
            data[key] = value
    return client.post("/oauth/token", data=data)


def test_authorization_rejects_oversized_client_state(client):
    registration = register_client(client)

    response = client.get(
        "/oauth/authorize",
        params={
            "response_type": "code",
            "client_id": registration["client_id"],
            "redirect_uri": CALLBACK_URI,
            "scope": "mcp:tools:read",
            "state": "s" * 513,
            "code_challenge": "A" * 43,
            "code_challenge_method": "S256",
            "resource": RESOURCE_URI,
        },
        follow_redirects=False,
    )

    assert response.status_code == 400
    assert response.json() == {"detail": "Invalid state"}


def test_authorization_rejects_when_request_store_is_at_capacity(
    client, gateway_module, monkeypatch
):
    registration = register_client(client)
    monkeypatch.setenv("AZURE_TENANT_ID", "test-tenant")
    monkeypatch.setenv("AZURE_CLIENT_ID", "test-client")
    monkeypatch.setenv("AZURE_CLIENT_SECRET", "test-client-secret")
    expires_at = gateway_module.time.time() + 600
    gateway_module._auth_requests.update(
        {
            f"state-{index}": {"expires_at": expires_at}
            for index in range(gateway_module._MAX_AUTH_REQUESTS)
        }
    )

    response = client.get(
        "/oauth/authorize",
        params={
            "response_type": "code",
            "client_id": registration["client_id"],
            "redirect_uri": CALLBACK_URI,
            "scope": "mcp:tools:read",
            "code_challenge": "A" * 43,
            "code_challenge_method": "S256",
            "resource": RESOURCE_URI,
        },
        follow_redirects=False,
    )

    assert response.status_code == 503
    assert response.json() == {
        "detail": "Authorization service temporarily unavailable"
    }
    assert len(gateway_module._auth_requests) == gateway_module._MAX_AUTH_REQUESTS


def test_oauth_code_store_capacity_evicts_expired_entries_only(gateway_module):
    future = gateway_module.time.time() + 600
    gateway_module._auth_codes.update(
        {
            f"code-{index}": {"expires_at": future}
            for index in range(gateway_module._MAX_AUTH_CODES)
        }
    )

    assert not gateway_module._oauth_store_has_capacity(
        gateway_module._auth_codes, gateway_module._MAX_AUTH_CODES
    )

    gateway_module._auth_codes["expired-code"] = {"expires_at": 0}
    del gateway_module._auth_codes["code-0"]

    assert gateway_module._oauth_store_has_capacity(
        gateway_module._auth_codes, gateway_module._MAX_AUTH_CODES
    )


def test_azure_user_id_is_bounded_before_authorization_code_storage(gateway_module):
    assert gateway_module._is_valid_azure_user_id("test-user")
    assert not gateway_module._is_valid_azure_user_id("")
    assert not gateway_module._is_valid_azure_user_id("u" * 257)
    assert not gateway_module._is_valid_azure_user_id(None)


@pytest.mark.parametrize("resource", [None, "https://other.example.com"])
def test_authorization_requires_exact_resource(client, resource):
    registration = register_client(client)
    params = {
        "response_type": "code",
        "client_id": registration["client_id"],
        "redirect_uri": CALLBACK_URI,
        "code_challenge": "A" * 43,
        "code_challenge_method": "S256",
    }
    if resource is not None:
        params["resource"] = resource

    response = client.get("/oauth/authorize", params=params, follow_redirects=False)

    assert response.status_code == 400
    assert response.json() == {"detail": "Invalid resource"}


@pytest.mark.parametrize(
    "scope",
    [
        "mcp:tools:read administrator",
        "mcp:tools:read\nforged",
        "mcp:tools:read " + ("a" * 300),
    ],
)
def test_authorization_rejects_unapproved_or_malformed_scope(client, scope):
    registration = register_client(client)

    response = client.get(
        "/oauth/authorize",
        params={
            "response_type": "code",
            "client_id": registration["client_id"],
            "redirect_uri": CALLBACK_URI,
            "scope": scope,
            "code_challenge": "A" * 43,
            "code_challenge_method": "S256",
            "resource": RESOURCE_URI,
        },
        follow_redirects=False,
    )

    assert response.status_code == 400
    assert response.json() == {"detail": "Invalid scope"}


@pytest.mark.parametrize(
    "challenge",
    ["A" * 42, "A" * 44, "A" * 42 + "+", "A" * 42 + "="],
)
def test_authorization_rejects_malformed_s256_challenge(client, challenge):
    registration = register_client(client)

    response = client.get(
        "/oauth/authorize",
        params={
            "response_type": "code",
            "client_id": registration["client_id"],
            "redirect_uri": CALLBACK_URI,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "resource": RESOURCE_URI,
        },
        follow_redirects=False,
    )

    assert response.status_code == 400
    assert response.json() == {"detail": "Invalid code_challenge"}


@pytest.mark.parametrize(
    ("missing_field", "detail"),
    [
        ("redirect_uri", "Redirect URI mismatch"),
        ("resource", "Invalid resource"),
    ],
)
def test_token_redemption_requires_exact_bound_values(
    client, gateway_module, missing_field, detail
):
    seed_authorization_code(gateway_module)

    response = redeem_code(client, **{missing_field: None})

    assert response.status_code == 400
    assert response.json() == {"detail": detail}


def test_token_redemption_rejects_non_ascii_verifier_without_server_error(
    client, gateway_module
):
    seed_authorization_code(gateway_module)

    response = redeem_code(client, code_verifier="é" * 43)

    assert response.status_code == 400
    assert response.json() == {"detail": "Invalid code_verifier"}


def test_pyjwt_verifies_real_rs256_token_from_jwk(gateway_module, monkeypatch):
    tenant_id = "11111111-1111-1111-1111-111111111111"
    client_id = "22222222-2222-2222-2222-222222222222"
    monkeypatch.setenv("AZURE_TENANT_ID", tenant_id)
    monkeypatch.setenv("AZURE_CLIENT_ID", client_id)
    monkeypatch.delenv("AZURE_AUDIENCE", raising=False)

    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public_numbers = private_key.public_key().public_numbers()

    def encoded_integer(value):
        raw = value.to_bytes((value.bit_length() + 7) // 8, "big")
        return gateway_module.jwt.utils.base64url_encode(raw).decode("ascii")

    jwk = {
        "kty": "RSA",
        "kid": "test-key",
        "use": "sig",
        "alg": "RS256",
        "n": encoded_integer(public_numbers.n),
        "e": encoded_integer(public_numbers.e),
    }

    async def fake_get_jwks():
        return {"keys": [jwk]}

    verifier = gateway_module.AzureTokenVerifier()
    monkeypatch.setattr(verifier, "_get_jwks", fake_get_jwks)
    now = int(time.time())
    claims = {
        "iss": f"https://login.microsoftonline.com/{tenant_id}/v2.0",
        "aud": client_id,
        "iat": now,
        "nbf": now,
        "exp": now + 300,
        "tid": tenant_id,
        "oid": "33333333-3333-3333-3333-333333333333",
    }

    def signed_token(payload):
        return gateway_module.jwt.encode(
            payload,
            private_key,
            algorithm="RS256",
            headers={"kid": "test-key"},
        )

    verified = asyncio.run(verifier.verify(signed_token(claims)))

    assert verified is not None
    assert verified["tid"] == tenant_id
    assert verified["oid"] == "33333333-3333-3333-3333-333333333333"

    missing_exp = dict(claims)
    missing_exp.pop("exp")
    expired = {**claims, "exp": now - 1}
    future_nbf = {**claims, "nbf": now + 300}

    assert asyncio.run(verifier.verify(signed_token(missing_exp))) is None
    assert asyncio.run(verifier.verify(signed_token(expired))) is None
    assert asyncio.run(verifier.verify(signed_token(future_nbf))) is None


def test_azure_verifier_refreshes_cached_jwks_once_for_unknown_key(
    gateway_module, monkeypatch
):
    verifier = gateway_module.AzureTokenVerifier()
    monkeypatch.setenv("AZURE_TENANT_ID", "test-tenant")
    monkeypatch.setenv("AZURE_CLIENT_ID", "test-client")
    calls = []

    async def get_jwks(force_refresh=False):
        calls.append(force_refresh)
        if force_refresh:
            return {"keys": [{"kid": "rotated-key"}]}
        return {"keys": [{"kid": "stale-key"}]}

    monkeypatch.setattr(verifier, "_get_jwks", get_jwks)
    monkeypatch.setattr(
        gateway_module.jwt,
        "get_unverified_header",
        lambda token: {"kid": "rotated-key"},
    )
    monkeypatch.setattr(
        gateway_module.jwt.PyJWK,
        "from_dict",
        lambda key: "verification-key",
    )
    monkeypatch.setattr(
        gateway_module.jwt,
        "decode",
        lambda *args, **kwargs: {"aud": "test-client"},
    )

    verified = asyncio.run(verifier.verify("opaque-token"))

    assert verified == {"aud": "test-client"}
    assert calls == [False, True]


def test_azure_verifier_logs_do_not_include_untrusted_claims_or_errors(
    gateway_module, monkeypatch, caplog
):
    verifier = gateway_module.AzureTokenVerifier()
    monkeypatch.setenv("AZURE_TENANT_ID", "test-tenant")
    monkeypatch.setenv("AZURE_CLIENT_ID", "test-client")

    async def get_jwks():
        return {"keys": [{"kid": "test-key"}]}

    monkeypatch.setattr(verifier, "_get_jwks", get_jwks)
    monkeypatch.setattr(
        gateway_module.jwt, "get_unverified_header", lambda token: {"kid": "test-key"}
    )
    hostile_audience = "hostile-audience\nforged-log-entry"
    monkeypatch.setattr(
        gateway_module.jwt,
        "decode",
        lambda *args, **kwargs: {"aud": hostile_audience},
    )

    with caplog.at_level(logging.INFO, logger="mcp_http_gateway"):
        assert asyncio.run(verifier.verify("opaque-token")) is None

    assert hostile_audience not in caplog.text
    caplog.clear()

    def raise_sensitive_error(token):
        raise RuntimeError("sensitive transport detail")

    monkeypatch.setattr(
        gateway_module.jwt, "get_unverified_header", raise_sensitive_error
    )

    with caplog.at_level(logging.INFO, logger="mcp_http_gateway"):
        assert asyncio.run(verifier.verify("opaque-token")) is None

    assert "sensitive transport detail" not in caplog.text


def test_oauth_callback_state_can_only_be_consumed_once(
    client, gateway_module, monkeypatch
):
    gateway_module._auth_requests["test-state"] = {
        "client_id": "test-client",
        "redirect_uri": CALLBACK_URI,
        "code_challenge": gateway_module._pkce_challenge(PKCE_VERIFIER),
        "code_challenge_method": "S256",
        "scope": "mcp:tools:read",
        "resource": RESOURCE_URI,
        "client_state": "client-state",
        "expires_at": gateway_module.time.time() + 600,
    }

    class TokenResponse:
        status_code = 200

        @staticmethod
        def json():
            return {"id_token": "test-id-token"}

    class AsyncClientStub:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, traceback):
            return False

        async def post(self, *args, **kwargs):
            return TokenResponse()

    async def verify_id_token(token):
        return {"sub": "test-user"}

    monkeypatch.setattr(gateway_module.httpx, "AsyncClient", AsyncClientStub)
    monkeypatch.setattr(gateway_module.azure_token_verifier, "verify", verify_id_token)

    first = client.get(
        "/oauth/callback",
        params={"code": "entra-code", "state": "test-state"},
        follow_redirects=False,
    )
    replay = client.get(
        "/oauth/callback",
        params={"code": "replayed-entra-code", "state": "test-state"},
        follow_redirects=False,
    )

    assert first.status_code in {302, 307}
    assert replay.status_code == 400
    assert replay.json() == {"detail": "Invalid or expired state"}
    assert "test-state" not in gateway_module._auth_requests


def test_oauth_callback_consumes_valid_state_on_upstream_error(client, gateway_module):
    gateway_module._auth_requests["error-state"] = {
        "expires_at": time.time() + 60,
    }

    response = client.get(
        "/oauth/callback",
        params={
            "error": "access_denied",
            "error_description": "untrusted",
            "state": "error-state",
        },
    )

    assert response.status_code == 400
    assert response.json() == {"detail": "Upstream authorization failed"}
    assert "error-state" not in gateway_module._auth_requests


def test_oauth_callback_consumes_valid_state_when_code_is_missing(
    client, gateway_module
):
    gateway_module._auth_requests["missing-code-state"] = {
        "expires_at": time.time() + 60,
    }

    response = client.get(
        "/oauth/callback",
        params={"state": "missing-code-state"},
    )

    assert response.status_code == 400
    assert response.json() == {"detail": "Missing code"}
    assert "missing-code-state" not in gateway_module._auth_requests


def test_oauth_callback_does_not_reflect_upstream_error_description(client):
    hostile_description = "sensitive upstream detail\nforged-log-line"

    response = client.get(
        "/oauth/callback",
        params={"error": "access_denied", "error_description": hostile_description},
    )

    assert response.status_code == 400
    assert response.json() == {"detail": "Missing state"}
    assert hostile_description not in response.text


def test_authorization_code_can_only_be_redeemed_once(client, gateway_module):
    seed_authorization_code(gateway_module)

    first = redeem_code(client)
    replay = redeem_code(client)

    assert first.status_code == 200, first.text
    assert replay.status_code == 400
    assert replay.json() == {"detail": "Invalid or expired authorization code"}
    assert "test-code" not in gateway_module._auth_codes


def test_redeemed_access_token_round_trips_through_local_verification(
    client, gateway_module
):
    seed_authorization_code(gateway_module)

    response = redeem_code(client)

    assert response.status_code == 200
    token = response.json()["access_token"]
    claims = gateway_module._verify_local_token(token)
    assert claims is not None
    assert claims["iss"] == RESOURCE_URI
    assert claims["aud"] == RESOURCE_URI
    assert claims["client_id"] == "test-client"
    assert claims["scope"] == "mcp:tools:read"


def test_local_token_verifier_requires_exp_and_iat(gateway_module):
    now = int(time.time())
    claims = {
        "sub": "test-user",
        "iss": RESOURCE_URI,
        "aud": RESOURCE_URI,
        "iat": now,
        "exp": now + 300,
    }

    def signed_token(payload):
        return gateway_module.jwt.encode(
            payload,
            gateway_module._jwt_secret(),
            algorithm="HS256",
        )

    assert gateway_module._verify_local_token(signed_token(claims)) is not None
    for omitted_claim in ("exp", "iat"):
        malformed = dict(claims)
        malformed.pop(omitted_claim)
        assert gateway_module._verify_local_token(signed_token(malformed)) is None


def test_token_rejects_any_non_post_client_authentication_method(
    client, gateway_module
):
    seed_authorization_code(gateway_module)
    gateway_module._clients["test-client"]["token_endpoint_auth_method"] = "none"

    response = redeem_code(client)

    assert response.status_code == 400
    assert response.json() == {"detail": "Invalid client authentication method"}


def test_non_ascii_client_secret_is_rejected_without_server_error(
    client, gateway_module
):
    seed_authorization_code(gateway_module)

    response = redeem_code(client, client_secret="p" + chr(229))

    assert response.status_code == 400
    assert response.json() == {"detail": "Invalid client secret"}


def test_non_ascii_static_bearer_is_rejected_without_exception(gateway_module):
    credentials = gateway_module.HTTPAuthorizationCredentials(
        scheme="Bearer", credentials="tøkén"
    )

    with pytest.raises(gateway_module.HTTPException) as exc_info:
        asyncio.run(gateway_module.verify_request(None, credentials))

    assert exc_info.value.status_code == 401
    assert exc_info.value.detail == "Invalid or expired token"


@pytest.mark.parametrize(
    "getter_name,env_name",
    [("_jwt_secret", "JWT_SECRET_KEY"), ("_static_token", "MCP_STATIC_TOKEN")],
)
@pytest.mark.parametrize("value", ["short", "x" * 31, "påssword" * 8])
def test_local_secrets_require_at_least_32_ascii_bytes(
    gateway_module, monkeypatch, getter_name, env_name, value
):
    monkeypatch.setenv(env_name, value)

    with pytest.raises(RuntimeError, match="must be at least 32 ASCII bytes"):
        getattr(gateway_module, getter_name)()


def test_client_secret_uses_constant_time_comparison(
    client, gateway_module, monkeypatch
):
    seed_authorization_code(gateway_module)
    comparisons = []

    def compare_digest(provided, expected):
        comparisons.append((provided, expected))
        return False

    monkeypatch.setattr(gateway_module.secrets, "compare_digest", compare_digest)

    response = redeem_code(client, client_secret="wrong-value")

    assert response.status_code == 400
    assert response.json() == {"detail": "Invalid client secret"}
    assert comparisons == [(b"wrong-value", b"unit-test-value")]


@pytest.mark.parametrize(
    "payload",
    [
        {
            "redirect_uris": [
                f"https://client.example.com/callback/{index}" for index in range(11)
            ]
        },
        {"redirect_uris": ["https://client.example.com/" + ("a" * 2048)]},
        {
            "redirect_uris": [CALLBACK_URI],
            "client_name": "n" * 129,
        },
    ],
)
def test_registration_rejects_oversized_metadata(client, payload):
    response = client.post("/oauth/register", json=payload)

    assert response.status_code == 400
    assert response.json() == {"detail": "Invalid client metadata"}


def test_registration_rejects_oversized_request_body(client):
    oversized_json = b'{"padding":"' + (b"a" * 17000) + b'"}'

    response = client.post(
        "/oauth/register",
        content=oversized_json,
        headers={"content-type": "application/json"},
    )

    assert response.status_code == 413
    assert response.json() == {"detail": "Registration request too large"}


def test_registration_store_has_a_hard_capacity(client, gateway_module):
    for index in range(1000):
        gateway_module._clients[f"client-{index}"] = {
            "expires_at": time.time() + 60,
        }

    response = client.post(
        "/oauth/register",
        json={"redirect_uris": [CALLBACK_URI]},
    )

    assert response.status_code == 503
    assert response.json() == {"detail": "Registration temporarily unavailable"}


def test_registration_evicts_expired_clients_before_capacity_check(
    client, gateway_module
):
    for index in range(1000):
        gateway_module._clients[f"expired-{index}"] = {
            "expires_at": time.time() - 1,
        }

    response = client.post(
        "/oauth/register",
        json={"redirect_uris": [CALLBACK_URI]},
    )

    assert response.status_code == 201
    assert len(gateway_module._clients) == 1


@pytest.mark.parametrize(
    "redirect_uri",
    [
        "https://",
        "https://user:password@client.example.com/callback",
        "https://client.example.com/callback?next=evil",
        "https://client.example.com/callback#fragment",
        "https://client.example.com/callback ",
        "https://client.example.com/callback\nforged",
        "http://client.example.com/callback",
    ],
)
def test_registration_rejects_unsafe_redirect_uris(
    client, gateway_module, redirect_uri
):
    response = client.post(
        "/oauth/register",
        json={
            "redirect_uris": [redirect_uri],
            "token_endpoint_auth_method": "client_secret_post",
            "grant_types": ["authorization_code"],
            "response_types": ["code"],
        },
    )

    assert response.status_code == 400
    assert response.json() == {"detail": "Invalid redirect URI"}
    assert gateway_module._clients == {}


@pytest.mark.parametrize(
    ("field", "value", "detail"),
    [
        (
            "grant_types",
            ["authorization_code", "refresh_token"],
            "grant_types must be ['authorization_code']",
        ),
        (
            "grant_types",
            "authorization_code",
            "grant_types must be ['authorization_code']",
        ),
        ("response_types", ["token"], "response_types must be ['code']"),
        ("response_types", "code", "response_types must be ['code']"),
    ],
)
def test_registration_rejects_unsupported_grant_and_response_metadata(
    client, gateway_module, field, value, detail
):
    payload = {
        "redirect_uris": ["https://client.example.com/callback"],
        "token_endpoint_auth_method": "client_secret_post",
        "grant_types": ["authorization_code"],
        "response_types": ["code"],
    }
    payload[field] = value

    response = client.post("/oauth/register", json=payload)

    assert response.status_code == 400
    assert response.json() == {"detail": detail}
    assert gateway_module._clients == {}


def test_discovery_advertises_only_implemented_oauth_features(client):
    response = client.get("/.well-known/oauth-authorization-server")

    assert response.status_code == 200
    metadata = response.json()
    assert metadata["grant_types_supported"] == ["authorization_code"]
    assert metadata["response_types_supported"] == ["code"]
    assert metadata["token_endpoint_auth_methods_supported"] == ["client_secret_post"]
    assert "client_id_metadata_document_supported" not in metadata


@pytest.mark.parametrize("method", ["client_secret_basic", "none", "unexpected"])
def test_registration_rejects_unenforced_token_authentication_methods(
    client, gateway_module, method
):
    response = client.post(
        "/oauth/register",
        json={
            "redirect_uris": [CALLBACK_URI],
            "token_endpoint_auth_method": method,
            "grant_types": ["authorization_code"],
            "response_types": ["code"],
        },
    )

    assert response.status_code == 400
    assert response.json() == {
        "detail": "token_endpoint_auth_method must be client_secret_post"
    }
    assert gateway_module._clients == {}


def test_unknown_authorization_client_is_rejected_without_registration(
    client, gateway_module
):
    response = client.get(
        "/oauth/authorize",
        params={
            "response_type": "code",
            "client_id": "attacker-selected-client",
            "redirect_uri": "https://attacker.example/callback",
            "code_challenge": "A" * 43,
            "code_challenge_method": "S256",
        },
        follow_redirects=False,
    )

    assert response.status_code == 400
    assert response.json() == {"detail": "Unknown client"}
    assert "attacker-selected-client" not in gateway_module._clients


def test_registration_does_not_advertise_unauthenticated_management(client):
    registration = register_client(client)

    assert "registration_client_uri" not in registration
    assert "registration_access_token" not in registration


def test_client_secret_is_returned_once_but_cannot_be_read_back(client):
    registration = register_client(client)
    assert registration["client_secret"]

    readback = client.get(f"/oauth/register/{registration['client_id']}")

    assert readback.status_code in {404, 405}
    assert registration["client_secret"] not in readback.text
