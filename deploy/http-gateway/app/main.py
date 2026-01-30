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
from contextlib import asynccontextmanager
from typing import Any, Dict, Optional

import httpx
from jose import jwt, JWTError
from fastapi import FastAPI, Request, Depends, HTTPException, Form, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse, JSONResponse
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


def _server_url() -> str:
    return os.getenv("SERVER_URL", "http://localhost:8000").rstrip("/")


def _resource_url() -> str:
    return os.getenv("MCP_RESOURCE_URL", _server_url()).rstrip("/")


def _static_token() -> str:
    return _get_required_env("MCP_STATIC_TOKEN")


def _jwt_secret() -> str:
    return _get_required_env("JWT_SECRET_KEY")


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


# --------------------------
# Azure AD token verification
# --------------------------

class AzureTokenVerifier:
    """Validate Azure AD JWTs using JWKS (v2.0 endpoints)."""

    def __init__(self) -> None:
        self._jwks_cache: Optional[Dict[str, Any]] = None
        self._jwks_cache_time = 0.0
        self._jwks_cache_ttl = 3600.0

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
        return values or None

    async def _get_jwks(self) -> Optional[Dict[str, Any]]:
        jwks_url = self._jwks_url()
        if not jwks_url:
            return None
        if self._jwks_cache and (time.time() - self._jwks_cache_time) < self._jwks_cache_ttl:
            return self._jwks_cache
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
                return None
            payload = jwt.decode(
                token,
                key,
                algorithms=["RS256"],
                audience=audiences,
                issuer=issuer,
            )
            return payload
        except JWTError:
            return None
        except Exception:
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
        )
        return payload
    except JWTError:
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


def _register_client(data: Dict[str, Any]) -> Dict[str, Any]:
    client_id = secrets.token_urlsafe(32)
    client_secret = secrets.token_urlsafe(48)
    client = {
        "client_id": client_id,
        "client_secret": client_secret,
        "redirect_uris": data.get("redirect_uris", []),
        "client_name": data.get("client_name", "MCP Client"),
        "token_endpoint_auth_method": data.get("token_endpoint_auth_method", "client_secret_post"),
        "grant_types": data.get("grant_types", ["authorization_code", "refresh_token"]),
        "response_types": data.get("response_types", ["code"]),
        "client_id_issued_at": int(time.time()),
    }
    _clients[client_id] = client
    return client


def _get_client(client_id: str) -> Optional[Dict[str, Any]]:
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
    if token == _static_token():
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
            "grant_types_supported": ["authorization_code", "refresh_token"],
            "token_endpoint_auth_methods_supported": ["client_secret_post", "client_secret_basic"],
            "code_challenge_methods_supported": ["S256"],
            "scopes_supported": ["mcp:tools:read", "mcp:tools:execute", "openid", "profile", "email"],
            "client_id_metadata_document_supported": True,
        }
    )


# --------------------------
# OAuth endpoints (DCR + Auth Code)
# --------------------------

@app.post("/oauth/register")
@app.post("/register")
async def register_client(redirect_uris: list[str], client_name: str = "MCP Client"):
    client = _register_client({"redirect_uris": redirect_uris, "client_name": client_name})
    return JSONResponse(content=client, status_code=201)


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
        raise HTTPException(status_code=400, detail="Invalid client_id")
    if redirect_uri not in client.get("redirect_uris", []):
        raise HTTPException(status_code=400, detail="Invalid redirect_uri")
    if code_challenge_method != "S256":
        raise HTTPException(status_code=400, detail="Only S256 code_challenge_method supported")

    expected_resource = _resource_url()
    if resource and resource != expected_resource:
        raise HTTPException(status_code=400, detail="Invalid resource")

    if not _azure_enabled():
        raise HTTPException(status_code=501, detail="Azure AD not configured on server")

    # Store auth request state
    _oauth_cleanup()
    state_id = secrets.token_urlsafe(24)
    _auth_requests[state_id] = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "code_challenge": code_challenge,
        "code_challenge_method": code_challenge_method,
        "scope": scope,
        "resource": resource or expected_resource,
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
    if error:
        raise HTTPException(status_code=400, detail=f"{error}: {error_description}")
    if not code or not state:
        raise HTTPException(status_code=400, detail="Missing code or state")

    _oauth_cleanup()
    req = _auth_requests.get(state)
    if not req:
        raise HTTPException(status_code=400, detail="Invalid or expired state")

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
    if id_token:
        user_payload = await azure_token_verifier.verify(id_token)
    if not user_payload:
        raise HTTPException(status_code=400, detail="Unable to verify Azure ID token")

    user_id = user_payload.get("sub") or user_payload.get("oid")

    # Create our own authorization code
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
    if redirect_uri and redirect_uri != expected_redirect:
        raise HTTPException(status_code=400, detail="Redirect URI mismatch")

    if client.get("token_endpoint_auth_method") == "client_secret_post":
        if not client_secret or client_secret != client.get("client_secret"):
            raise HTTPException(status_code=400, detail="Invalid client secret")

    if not code_verifier or not _verify_pkce(code_verifier, auth_code["code_challenge"], auth_code["code_challenge_method"]):
        raise HTTPException(status_code=400, detail="Invalid code_verifier")

    expected_resource = auth_code["resource"]
    if resource and resource != expected_resource:
        raise HTTPException(status_code=400, detail="Invalid resource")

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

@app.api_route("/mcp", methods=["GET", "POST"])
async def mcp_endpoint(
    request: Request,
    _auth: Dict[str, Any] = Depends(verify_request),
):
    return await mcp.handle_streamable_http(request)


@app.api_route("/sse", methods=["GET", "POST"])
async def sse_endpoint(
    request: Request,
    _auth: Dict[str, Any] = Depends(verify_request),
):
    return await mcp.handle_sse(request)
