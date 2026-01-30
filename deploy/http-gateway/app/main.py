"""
HTTP gateway for the ConnectWise MCP server with static token auth.
SSO (Azure AD) can be added later without changing the public endpoints.
"""
import os
import logging
import time
from contextlib import asynccontextmanager
from typing import Any, Dict, Optional

from fastapi import FastAPI, Request, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import jwt, JWTError
import httpx

# Reuse the existing MCP server + tools
from api_gateway.server import (
    logger as mcp_logger,
    mcp,
    setup_config,
    initialize_database,
    initialize_fast_memory,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("mcp_http_gateway")

security = HTTPBearer(auto_error=False)


def _get_required_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def _static_token() -> str:
    return _get_required_env("MCP_STATIC_TOKEN")


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


async def verify_request(
    request: Request,
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security),
) -> Dict[str, Any]:
    """Verify Authorization header with a static bearer token or Azure AD JWT."""
    if not credentials or credentials.scheme.lower() != "bearer":
        raise HTTPException(
            status_code=401,
            detail="Missing or invalid authorization header",
            headers={"WWW-Authenticate": "Bearer"},
        )

    token = credentials.credentials

    # Static token check (required)
    if token == _static_token():
        return {"auth": "static"}

    # Azure AD validation (optional, requires env vars)
    azure_payload = await azure_token_verifier.verify(token)
    if azure_payload:
        return {
            "auth": "azure_ad",
            "user_id": azure_payload.get("sub"),
            "tenant": azure_payload.get("tid"),
            "scopes": azure_payload.get("scp") or azure_payload.get("roles"),
        }

    raise HTTPException(
        status_code=401,
        detail="Invalid or expired token",
        headers={"WWW-Authenticate": "Bearer error=\"invalid_token\""},
    )


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Fail fast if token is not configured
    _static_token()

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

# CORS: lock this down for production if needed
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health_check():
    return {"status": "healthy"}


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


# Mount streamable HTTP app for compatibility (still protected by above routes)
app.mount("/", mcp.streamable_http_app())
