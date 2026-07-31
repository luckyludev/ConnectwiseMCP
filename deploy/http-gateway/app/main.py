"""
HTTP gateway for the ConnectWise MCP server.

Supports:
- Static bearer token auth
- OAuth 2.1 Authorization Server endpoints (DCR + PKCE)
- Azure AD login as the user authentication source

Implements MCP authorization discovery requirements and OpenAI connector guidance.
"""
import os
import time
import secrets
import logging
import hashlib
import base64
import json
import re
from contextlib import asynccontextmanager
from typing import Any, Dict, Optional
from urllib.parse import parse_qs, urlsplit

import httpx
import jwt
from fastapi import FastAPI, Request, Depends, HTTPException, Form, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse, JSONResponse, Response
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

# Reuse the existing MCP server + tools
from api_gateway.server import (
    mcp,
    setup_config,
    initialize_database,
    initialize_fast_memory,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("mcp_http_gateway")

security = HTTPBearer(auto_error=False)

_PKCE_S256_CHALLENGE_PATTERN = re.compile(r"^[A-Za-z0-9_-]{43}$")
_PKCE_VERIFIER_PATTERN = re.compile(r"^[A-Za-z0-9._~-]{43,128}$")
_ALLOWED_OAUTH_SCOPES = frozenset(
    {"mcp:tools:read", "mcp:tools:execute", "openid", "profile", "email"}
)
_MAX_REGISTERED_CLIENTS = 1000
_REGISTERED_CLIENT_TTL_SECONDS = 86400
_MAX_REDIRECT_URIS = 10
_MAX_REDIRECT_URI_LENGTH = 2048
_MAX_CLIENT_NAME_LENGTH = 128
_MAX_REGISTRATION_BODY_BYTES = 16 * 1024
_MAX_AUTH_REQUESTS = 1000
_MAX_AUTH_CODES = 1000
_MAX_CLIENT_STATE_LENGTH = 512
_MAX_AZURE_USER_ID_LENGTH = 256

# In-memory stores (use Redis/DB in production)
_clients: Dict[str, Dict[str, Any]] = {}
_auth_requests: Dict[str, Dict[str, Any]] = {}
_auth_codes: Dict[str, Dict[str, Any]] = {}


# --------------------------
# Config helpers
# --------------------------

def _get_required_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def _get_required_local_secret(name: str) -> str:
    value = _get_required_env(name)
    try:
        encoded = value.encode("ascii")
    except UnicodeEncodeError as exc:
        raise RuntimeError(f"{name} must be at least 32 ASCII bytes") from exc
    if len(encoded) < 32:
        raise RuntimeError(f"{name} must be at least 32 ASCII bytes")
    return value


def _server_url() -> str:
    return os.getenv("SERVER_URL", "http://localhost:8000").rstrip("/")


def _resource_url() -> str:
    return os.getenv("MCP_RESOURCE_URL", _server_url()).rstrip("/")


def _static_token() -> str:
    return _get_required_local_secret("MCP_STATIC_TOKEN")


def _jwt_secret() -> str:
    return _get_required_local_secret("JWT_SECRET_KEY")


def _azure_enabled() -> bool:
    return bool(os.getenv("AZURE_TENANT_ID") and os.getenv("AZURE_CLIENT_ID") and os.getenv("AZURE_CLIENT_SECRET"))


# --------------------------
# PKCE helpers
# --------------------------

def _pkce_challenge(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def _verify_pkce(verifier: str, challenge: str, method: str) -> bool:
    if method != "S256":
        return False
    return secrets.compare_digest(_pkce_challenge(verifier), challenge)


def _constant_time_text_equals(left: Any, right: Any) -> bool:
    if not isinstance(left, str) or not isinstance(right, str):
        return False
    try:
        left_bytes = left.encode("ascii")
        right_bytes = right.encode("ascii")
    except UnicodeEncodeError:
        return False
    return secrets.compare_digest(left_bytes, right_bytes)


def _is_valid_pkce_challenge(challenge: Any) -> bool:
    return isinstance(challenge, str) and bool(_PKCE_S256_CHALLENGE_PATTERN.fullmatch(challenge))


def _is_valid_pkce_verifier(verifier: Any) -> bool:
    return isinstance(verifier, str) and bool(_PKCE_VERIFIER_PATTERN.fullmatch(verifier))


def _validated_scope(scope: Any) -> Optional[str]:
    if not isinstance(scope, str) or not scope or len(scope) > 256:
        return None
    parts = scope.split(" ")
    if (
        any(not part or part not in _ALLOWED_OAUTH_SCOPES for part in parts)
        or len(parts) != len(set(parts))
        or " ".join(parts) != scope
    ):
        return None
    return scope


def _is_valid_azure_user_id(value: Any) -> bool:
    return isinstance(value, str) and bool(value) and len(value) <= _MAX_AZURE_USER_ID_LENGTH


def _is_valid_redirect_uri(uri: Any) -> bool:
    if not isinstance(uri, str) or not uri:
        return False
    if any(ord(char) < 0x21 or ord(char) > 0x7E for char in uri):
        return False

    try:
        parsed = urlsplit(uri)
        port = parsed.port
    except ValueError:
        return False

    return (
        parsed.scheme == "https"
        and bool(parsed.netloc)
        and bool(parsed.hostname)
        and parsed.username is None
        and parsed.password is None
        and parsed.query == ""
        and parsed.fragment == ""
        and (port is None or 1 <= port <= 65535)
    )


async def _read_registration_payload(request: Request) -> Dict[str, Any]:
    content_length = request.headers.get("content-length")
    if content_length is not None:
        try:
            if int(content_length) > _MAX_REGISTRATION_BODY_BYTES:
                raise HTTPException(
                    status_code=413,
                    detail="Registration request too large",
                )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Invalid request body") from exc

    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > _MAX_REGISTRATION_BODY_BYTES:
            raise HTTPException(
                status_code=413,
                detail="Registration request too large",
            )

    content_type = (
        request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    )
    payload: Any
    try:
        if content_type == "application/json":
            payload = json.loads(bytes(body).decode("utf-8"))
        elif content_type == "application/x-www-form-urlencoded":
            values = parse_qs(
                bytes(body).decode("utf-8"),
                keep_blank_values=True,
                max_num_fields=50,
            )
            payload = {key: entries[-1] for key, entries in values.items()}
            if "redirect_uris" in values:
                payload["redirect_uris"] = values["redirect_uris"]
        else:
            raise HTTPException(status_code=415, detail="Unsupported content type")
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail="Invalid request body") from exc

    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Invalid registration payload")
    return payload


# --------------------------
# Azure AD token verification
# --------------------------

class AzureTokenVerifier:
    """Validate Azure AD JWTs using JWKS (v2.0 endpoints)."""

    def __init__(self) -> None:
        self._jwks_cache: Optional[Dict[str, Any]] = None
        self._jwks_cache_time = 0.0
        self._jwks_cache_ttl = 3600.0
        self._jwks_forced_refresh_time = 0.0
        self._jwks_forced_refresh_cooldown = 60.0

    def _tenant_id(self) -> Optional[str]:
        return os.getenv("AZURE_TENANT_ID")

    def _issuer(self) -> Optional[str]:
        tenant_id = self._tenant_id()
        if not tenant_id:
            return None
        return f"https://login.microsoftonline.com/{tenant_id}/v2.0"

    def _jwks_url(self) -> Optional[str]:
        tenant_id = self._tenant_id()
        if not tenant_id:
            return None
        return f"https://login.microsoftonline.com/{tenant_id}/discovery/v2.0/keys"

    def _audiences(self) -> Optional[list[str]]:
        audience = os.getenv("AZURE_AUDIENCE")
        client_id = os.getenv("AZURE_CLIENT_ID")
        values = [v for v in [audience, client_id] if v]
        # Common Azure audience variant for app IDs
        if client_id:
            values.append(f"api://{client_id}")
        # de-dup while preserving order
        deduped = []
        for v in values:
            if v and v not in deduped:
                deduped.append(v)
        return deduped or None

    async def _get_jwks(
        self, force_refresh: bool = False
    ) -> Optional[Dict[str, Any]]:
        jwks_url = self._jwks_url()
        if not jwks_url:
            return None
        now = time.time()
        if (
            force_refresh
            and self._jwks_cache
            and (now - self._jwks_forced_refresh_time)
            < self._jwks_forced_refresh_cooldown
        ):
            return self._jwks_cache
        if (
            not force_refresh
            and self._jwks_cache
            and (now - self._jwks_cache_time) < self._jwks_cache_ttl
        ):
            return self._jwks_cache
        if force_refresh:
            self._jwks_forced_refresh_time = now
        async with httpx.AsyncClient() as client:
            resp = await client.get(jwks_url, timeout=10.0)
            resp.raise_for_status()
            self._jwks_cache = resp.json()
            self._jwks_cache_time = time.time()
            return self._jwks_cache

    async def verify(self, token: str) -> Optional[Dict[str, Any]]:
        issuer = self._issuer()
        audiences = self._audiences()
        if not issuer or not audiences:
            return None

        try:
            jwks = await self._get_jwks()
            if not jwks:
                return None
            header = jwt.get_unverified_header(token)
            key = None
            for k in jwks.get("keys", []):
                if k.get("kid") == header.get("kid"):
                    key = k
                    break
            if not key:
                jwks = await self._get_jwks(force_refresh=True)
                if not jwks:
                    return None
                for k in jwks.get("keys", []):
                    if k.get("kid") == header.get("kid"):
                        key = k
                        break
                if not key:
                    return None
            verification_key = jwt.PyJWK.from_dict(key)
            payload = jwt.decode(
                token,
                verification_key,
                algorithms=["RS256"],
                issuer=issuer,
                options={"verify_aud": False, "require": ["exp", "iat"]},
            )

            # Accept only an explicitly configured audience after signature/issuer validation.
            token_aud = payload.get("aud")
            if isinstance(token_aud, str):
                aud_ok = token_aud in audiences
            elif isinstance(token_aud, list):
                aud_ok = any(a in audiences for a in token_aud)
            else:
                aud_ok = False

            if not aud_ok:
                logger.warning("Azure token audience validation failed")
                return None

            return payload
        except jwt.PyJWTError:
            logger.warning("Azure token JWT validation failed")
            return None
        except Exception:
            logger.error("Azure token verification unavailable")
            return None


azure_token_verifier = AzureTokenVerifier()


# --------------------------
# Local JWT tokens (issued by this server)
# --------------------------

def _issue_local_token(user_id: str, scope: str, client_id: str, audience: str, expires_in: int = 3600) -> str:
    now = int(time.time())
    payload = {
        "iss": _server_url(),
        "sub": user_id,
        "aud": audience,
        "iat": now,
        "exp": now + expires_in,
        "scope": scope,
        "client_id": client_id,
    }
    return jwt.encode(payload, _jwt_secret(), algorithm="HS256")


def _verify_local_token(token: str) -> Optional[Dict[str, Any]]:
    try:
        payload = jwt.decode(
            token,
            _jwt_secret(),
            algorithms=["HS256"],
            audience=_resource_url(),
            issuer=_server_url(),
            options={"require": ["exp", "iat"]},
        )
        return payload
    except jwt.PyJWTError:
        return None


# --------------------------
# OAuth helpers
# --------------------------

def _oauth_cleanup() -> None:
    now = time.time()
    for store in (_auth_requests, _auth_codes):
        expired = [k for k, v in store.items() if v.get("expires_at", 0) <= now]
        for k in expired:
            del store[k]


def _oauth_store_has_capacity(store: Dict[str, Dict[str, Any]], limit: int) -> bool:
    _oauth_cleanup()
    return len(store) < limit


def _client_cleanup() -> None:
    now = time.time()
    expired = [
        client_id
        for client_id, client in _clients.items()
        if client.get("expires_at") is not None
        and client.get("expires_at", 0) <= now
    ]
    for client_id in expired:
        del _clients[client_id]


def _register_client(data: Dict[str, Any]) -> Dict[str, Any]:
    client_id = secrets.token_urlsafe(32)
    client_secret = secrets.token_urlsafe(48)
    client = {
        "client_id": client_id,
        "client_secret": client_secret,
        "redirect_uris": data.get("redirect_uris", []),
        "client_name": data.get("client_name", "MCP Client"),
        "token_endpoint_auth_method": "client_secret_post",
        "grant_types": ["authorization_code"],
        "response_types": ["code"],
        "client_id_issued_at": int(time.time()),
        "expires_at": time.time() + _REGISTERED_CLIENT_TTL_SECONDS,
    }
    _clients[client_id] = client
    return client


def _get_client(client_id: str) -> Optional[Dict[str, Any]]:
    _client_cleanup()
    return _clients.get(client_id)


def _resource_metadata_url() -> str:
    return f"{_server_url()}/.well-known/oauth-protected-resource"


# --------------------------
# Auth guard
# --------------------------

async def verify_request(
    request: Request,
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security),
) -> Dict[str, Any]:
    if not credentials or credentials.scheme.lower() != "bearer":
        raise HTTPException(
            status_code=401,
            detail="Missing or invalid authorization header",
            headers={
                "WWW-Authenticate": f'Bearer realm="mcp", resource_metadata="{_resource_metadata_url()}"'
            },
        )

    token = credentials.credentials

    # Static token check
    if _constant_time_text_equals(token, _static_token()):
        return {"auth": "static"}

    # Local JWT tokens
    local_payload = _verify_local_token(token)
    if local_payload:
        return {"auth": "local_jwt", "user_id": local_payload.get("sub"), "scopes": local_payload.get("scope")}

    # Azure AD tokens
    azure_payload = await azure_token_verifier.verify(token)
    if azure_payload:
        return {
            "auth": "azure_ad",
            "user_id": azure_payload.get("sub") or azure_payload.get("oid"),
            "tenant": azure_payload.get("tid"),
            "scopes": azure_payload.get("scp") or azure_payload.get("roles"),
        }

    raise HTTPException(
        status_code=401,
        detail="Invalid or expired token",
        headers={
            "WWW-Authenticate": f'Bearer error="invalid_token", resource_metadata="{_resource_metadata_url()}"'
        },
    )


# --------------------------
# FastAPI lifecycle
# --------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Fail fast if required envs are not configured
    _static_token()
    _jwt_secret()

    # Initialize MCP server internals
    setup_config()
    initialize_database()
    initialize_fast_memory()

    # Warm session manager / streamable app
    mcp.streamable_http_app()

    async with mcp.session_manager.run():
        logger.info("MCP HTTP gateway started")
        yield

    logger.info("MCP HTTP gateway stopped")


app = FastAPI(title="ConnectWise MCP HTTP Gateway", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# --------------------------
# Health + discovery
# --------------------------

@app.get("/health")
async def health_check():
    return {"status": "healthy"}


@app.get("/.well-known/oauth-protected-resource")
async def protected_resource_metadata():
    return JSONResponse(
        content={
            "resource": _resource_url(),
            "authorization_servers": [_server_url()],
            "bearer_methods_supported": ["header"],
            "resource_signing_alg_values_supported": ["HS256", "RS256"],
            "scopes_supported": ["mcp:tools:read", "mcp:tools:execute", "openid", "profile", "email"],
        }
    )


@app.get("/.well-known/oauth-authorization-server")
async def authorization_server_metadata():
    base = _server_url()
    return JSONResponse(
        content={
            "issuer": base,
            "authorization_endpoint": f"{base}/oauth/authorize",
            "token_endpoint": f"{base}/oauth/token",
            "registration_endpoint": f"{base}/oauth/register",
            "response_types_supported": ["code"],
            "response_modes_supported": ["query"],
            "grant_types_supported": ["authorization_code"],
            "token_endpoint_auth_methods_supported": ["client_secret_post"],
            "code_challenge_methods_supported": ["S256"],
            "scopes_supported": ["mcp:tools:read", "mcp:tools:execute", "openid", "profile", "email"],
        }
    )


# --------------------------
# OAuth endpoints (DCR + Auth Code)
# --------------------------

@app.post("/oauth/register")
@app.post("/register")
async def register_client(request: Request):
    """Bounded RFC7591-style Dynamic Client Registration endpoint.

    Accepts JSON (preferred) or URL-encoded form fields.
    """
    payload = await _read_registration_payload(request)

    redirect_uris = payload.get("redirect_uris") or []
    if isinstance(redirect_uris, str):
        redirect_uris = [redirect_uris]

    _client_cleanup()
    if len(_clients) >= _MAX_REGISTERED_CLIENTS:
        raise HTTPException(
            status_code=503,
            detail="Registration temporarily unavailable",
        )

    # Require clean absolute HTTPS redirect URIs that can be matched literally.
    if not isinstance(redirect_uris, list) or not redirect_uris:
        raise HTTPException(status_code=400, detail="redirect_uris is required")
    if len(redirect_uris) > _MAX_REDIRECT_URIS:
        raise HTTPException(status_code=400, detail="Invalid client metadata")
    for uri in redirect_uris:
        if not isinstance(uri, str) or len(uri) > _MAX_REDIRECT_URI_LENGTH:
            raise HTTPException(status_code=400, detail="Invalid client metadata")
        if not _is_valid_redirect_uri(uri):
            raise HTTPException(status_code=400, detail="Invalid redirect URI")

    client_name = payload.get("client_name", "MCP Client")
    if (
        not isinstance(client_name, str)
        or not client_name
        or len(client_name) > _MAX_CLIENT_NAME_LENGTH
        or any(ord(char) < 0x20 or ord(char) == 0x7F for char in client_name)
    ):
        raise HTTPException(status_code=400, detail="Invalid client metadata")
    token_auth_method = payload.get("token_endpoint_auth_method", "client_secret_post")
    if token_auth_method != "client_secret_post":
        raise HTTPException(
            status_code=400,
            detail="token_endpoint_auth_method must be client_secret_post",
        )
    grant_types = payload.get("grant_types", ["authorization_code"])
    response_types = payload.get("response_types", ["code"])
    if grant_types != ["authorization_code"]:
        raise HTTPException(
            status_code=400,
            detail="grant_types must be ['authorization_code']",
        )
    if response_types != ["code"]:
        raise HTTPException(
            status_code=400,
            detail="response_types must be ['code']",
        )

    client = _register_client(
        {
            "redirect_uris": redirect_uris,
            "client_name": client_name,
            "token_endpoint_auth_method": token_auth_method,
            "grant_types": grant_types,
            "response_types": response_types,
        }
    )

    # RFC7591-style response fields
    resp = {
        **client,
        "redirect_uris": redirect_uris,
        "grant_types": grant_types,
        "response_types": response_types,
        "token_endpoint_auth_method": token_auth_method,
        "client_secret_expires_at": 0,
    }
    return JSONResponse(content=resp, status_code=201)


@app.get("/oauth/authorize")
async def oauth_authorize(
    response_type: str = Query(...),
    client_id: str = Query(...),
    redirect_uri: str = Query(...),
    scope: str = Query("openid profile email"),
    state: Optional[str] = Query(None),
    code_challenge: str = Query(...),
    code_challenge_method: str = Query("S256"),
    resource: Optional[str] = Query(None),
):
    if response_type != "code":
        raise HTTPException(status_code=400, detail="Unsupported response_type")

    client = _get_client(client_id)
    if not client:
        raise HTTPException(status_code=400, detail="Unknown client")
    if redirect_uri not in client.get("redirect_uris", []):
        raise HTTPException(status_code=400, detail="Invalid redirect_uri")
    if code_challenge_method != "S256":
        raise HTTPException(status_code=400, detail="Only S256 code_challenge_method supported")
    if not _is_valid_pkce_challenge(code_challenge):
        raise HTTPException(status_code=400, detail="Invalid code_challenge")

    expected_resource = _resource_url()
    if resource != expected_resource:
        raise HTTPException(status_code=400, detail="Invalid resource")
    validated_scope = _validated_scope(scope)
    if validated_scope is None:
        raise HTTPException(status_code=400, detail="Invalid scope")
    if state is not None and len(state) > _MAX_CLIENT_STATE_LENGTH:
        raise HTTPException(status_code=400, detail="Invalid state")

    if not _azure_enabled():
        raise HTTPException(status_code=501, detail="Azure AD not configured on server")

    # Store auth request state
    if not _oauth_store_has_capacity(_auth_requests, _MAX_AUTH_REQUESTS):
        raise HTTPException(status_code=503, detail="Authorization service temporarily unavailable")
    state_id = secrets.token_urlsafe(24)
    _auth_requests[state_id] = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "code_challenge": code_challenge,
        "code_challenge_method": code_challenge_method,
        "scope": validated_scope,
        "resource": resource,
        "client_state": state,
        "expires_at": time.time() + 600,
    }

    # Redirect to Azure AD for login
    tenant_id = os.getenv("AZURE_TENANT_ID")
    azure_auth_url = f"https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/authorize"
    params = {
        "response_type": "code",
        "client_id": os.getenv("AZURE_CLIENT_ID"),
        "redirect_uri": f"{_server_url()}/oauth/callback",
        "scope": os.getenv("AZURE_SCOPES", "openid profile email"),
        "state": state_id,
    }
    return RedirectResponse(url=f"{azure_auth_url}?{httpx.QueryParams(params)}")


@app.get("/oauth/callback")
async def oauth_callback(
    code: Optional[str] = Query(None),
    state: Optional[str] = Query(None),
    error: Optional[str] = Query(None),
    error_description: Optional[str] = Query(None),
):
    if not state:
        raise HTTPException(status_code=400, detail="Missing state")

    _oauth_cleanup()
    req = _auth_requests.pop(state, None)
    if not req:
        raise HTTPException(status_code=400, detail="Invalid or expired state")

    if error:
        raise HTTPException(status_code=400, detail="Upstream authorization failed")
    if not code:
        raise HTTPException(status_code=400, detail="Missing code")

    # Exchange code with Azure AD
    tenant_id = os.getenv("AZURE_TENANT_ID")
    token_url = f"https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token"
    async with httpx.AsyncClient() as client:
        token_resp = await client.post(
            token_url,
            data={
                "grant_type": "authorization_code",
                "client_id": os.getenv("AZURE_CLIENT_ID"),
                "client_secret": os.getenv("AZURE_CLIENT_SECRET"),
                "code": code,
                "redirect_uri": f"{_server_url()}/oauth/callback",
            },
            timeout=15.0,
        )
    if token_resp.status_code != 200:
        raise HTTPException(status_code=400, detail="Azure token exchange failed")

    tokens = token_resp.json()
    id_token = tokens.get("id_token")
    user_payload = None
    if not id_token:
        raise HTTPException(status_code=400, detail="Azure token response missing id_token (check AZURE_SCOPES includes openid)")

    user_payload = await azure_token_verifier.verify(id_token)
    if not user_payload:
        raise HTTPException(status_code=400, detail="Unable to verify Azure ID token (check AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_AUDIENCE)")

    user_id = user_payload.get("sub") or user_payload.get("oid")
    if not _is_valid_azure_user_id(user_id):
        raise HTTPException(status_code=400, detail="Unable to verify Azure ID token")

    # Create our own authorization code
    if not _oauth_store_has_capacity(_auth_codes, _MAX_AUTH_CODES):
        raise HTTPException(status_code=503, detail="Authorization service temporarily unavailable")

    auth_code = secrets.token_urlsafe(32)
    _auth_codes[auth_code] = {
        "client_id": req["client_id"],
        "redirect_uri": req["redirect_uri"],
        "code_challenge": req["code_challenge"],
        "code_challenge_method": req["code_challenge_method"],
        "scope": req["scope"],
        "resource": req["resource"],
        "user_id": user_id,
        "expires_at": time.time() + 600,
    }

    redirect_params = {"code": auth_code}
    if req.get("client_state"):
        redirect_params["state"] = req["client_state"]

    return RedirectResponse(url=f"{req['redirect_uri']}?{httpx.QueryParams(redirect_params)}")


@app.post("/oauth/token")
async def oauth_token(
    grant_type: str = Form(...),
    code: Optional[str] = Form(None),
    redirect_uri: Optional[str] = Form(None),
    client_id: str = Form(...),
    client_secret: Optional[str] = Form(None),
    code_verifier: Optional[str] = Form(None),
    resource: Optional[str] = Form(None),
):
    if grant_type != "authorization_code":
        raise HTTPException(status_code=400, detail="Unsupported grant_type")

    _oauth_cleanup()
    auth_code = _auth_codes.get(code or "")
    if not auth_code:
        raise HTTPException(status_code=400, detail="Invalid or expired authorization code")

    if auth_code["client_id"] != client_id:
        raise HTTPException(status_code=400, detail="Client mismatch")

    client = _get_client(client_id)
    if not client:
        raise HTTPException(status_code=400, detail="Unknown client")

    expected_redirect = auth_code["redirect_uri"]
    if redirect_uri != expected_redirect:
        raise HTTPException(status_code=400, detail="Redirect URI mismatch")

    if client.get("token_endpoint_auth_method") != "client_secret_post":
        raise HTTPException(
            status_code=400,
            detail="Invalid client authentication method",
        )

    expected_client_secret = client.get("client_secret")
    if not _constant_time_text_equals(client_secret, expected_client_secret):
        raise HTTPException(status_code=400, detail="Invalid client secret")

    if (
        not isinstance(code_verifier, str)
        or not _is_valid_pkce_verifier(code_verifier)
        or not _verify_pkce(
            code_verifier,
            auth_code["code_challenge"],
            auth_code["code_challenge_method"],
        )
    ):
        raise HTTPException(status_code=400, detail="Invalid code_verifier")

    expected_resource = auth_code["resource"]
    if resource != expected_resource:
        raise HTTPException(status_code=400, detail="Invalid resource")

    # Consume the authorization code before issuing a token so it cannot replay.
    _auth_codes.pop(code or "", None)

    access_token = _issue_local_token(
        user_id=auth_code["user_id"],
        scope=auth_code["scope"],
        client_id=client_id,
        audience=expected_resource,
        expires_in=3600,
    )

    return {
        "access_token": access_token,
        "token_type": "Bearer",
        "expires_in": 3600,
        "scope": auth_code["scope"],
    }


# --------------------------
# MCP endpoints (protected)
# --------------------------

async def _proxy_asgi_app(asgi_app, request: Request, path: str = "/") -> Response:
    body = await request.body()
    # Forward only safe ASCII headers needed by MCP handlers.
    headers = {}
    for k in ("authorization", "content-type", "accept", "mcp-session-id", "last-event-id"):
        v = request.headers.get(k)
        if not v:
            continue
        try:
            v.encode("ascii")
        except UnicodeEncodeError:
            continue
        headers[k] = v
    headers["host"] = httpx.URL(_server_url()).host
    transport = httpx.ASGITransport(app=asgi_app)
    async with httpx.AsyncClient(transport=transport, base_url=_server_url()) as client:
        resp = await client.request(
            request.method,
            path,
            headers=headers,
            content=body,
            params=dict(request.query_params),
        )
    return Response(
        content=resp.content,
        status_code=resp.status_code,
        headers=dict(resp.headers),
        media_type=resp.headers.get("content-type"),
    )


@app.api_route("/mcp", methods=["GET", "POST"])
async def mcp_endpoint(
    request: Request,
    _auth: Dict[str, Any] = Depends(verify_request),
):
    return await _proxy_asgi_app(mcp.streamable_http_app(), request, path="/mcp")


@app.api_route("/sse", methods=["GET", "POST"])
async def sse_endpoint(
    request: Request,
    _auth: Dict[str, Any] = Depends(verify_request),
):
    return await _proxy_asgi_app(mcp.sse_app(), request, path="/sse")
