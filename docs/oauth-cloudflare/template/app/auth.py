"""
OAuth 2.1 Authentication for MCP Server
Implements MCP Authorization Specification (2025-03-26)
"""
import secrets
import hashlib
import base64
import time
import json
import logging
from datetime import datetime, timedelta
from typing import Optional, Dict, Any
from dataclasses import dataclass, field

import httpx
from jose import jwt, JWTError
from fastapi import Request, HTTPException, Depends
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel

from config import get_settings, Settings

logger = logging.getLogger(__name__)

# Security scheme
security = HTTPBearer(auto_error=False)


@dataclass
class RegisteredClient:
    """Dynamically registered OAuth client"""
    client_id: str
    client_secret: str
    redirect_uris: list[str]
    client_name: str
    created_at: float = field(default_factory=time.time)
    
    def to_dict(self) -> dict:
        return {
            "client_id": self.client_id,
            "client_secret": self.client_secret,
            "redirect_uris": self.redirect_uris,
            "client_name": self.client_name,
            "token_endpoint_auth_method": "client_secret_post",
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
        }


@dataclass
class AuthorizationCode:
    """Authorization code for OAuth flow"""
    code: str
    client_id: str
    redirect_uri: str
    code_challenge: str
    code_challenge_method: str
    scope: str
    user_id: str
    expires_at: float


@dataclass
class AccessTokenData:
    """Access token data"""
    token: str
    client_id: str
    user_id: str
    scope: str
    expires_at: float


class OAuthStore:
    """In-memory store for OAuth state (use Redis/DB in production)"""
    
    def __init__(self):
        self.clients: Dict[str, RegisteredClient] = {}
        self.auth_codes: Dict[str, AuthorizationCode] = {}
        self.access_tokens: Dict[str, AccessTokenData] = {}
        self.refresh_tokens: Dict[str, Dict[str, Any]] = {}
    
    def register_client(self, client_data: dict) -> RegisteredClient:
        """Register a new OAuth client (RFC 7591)"""
        client_id = secrets.token_urlsafe(32)
        client_secret = secrets.token_urlsafe(48)
        
        client = RegisteredClient(
            client_id=client_id,
            client_secret=client_secret,
            redirect_uris=client_data.get("redirect_uris", []),
            client_name=client_data.get("client_name", "MCP Client"),
        )
        
        self.clients[client_id] = client
        logger.info(f"Registered new client: {client_id}")
        return client
    
    def get_client(self, client_id: str) -> Optional[RegisteredClient]:
        return self.clients.get(client_id)
    
    def store_auth_code(self, code: AuthorizationCode):
        self.auth_codes[code.code] = code
    
    def get_auth_code(self, code: str) -> Optional[AuthorizationCode]:
        auth_code = self.auth_codes.get(code)
        if auth_code and auth_code.expires_at > time.time():
            # Single use - delete after retrieval
            del self.auth_codes[code]
            return auth_code
        return None
    
    def store_access_token(self, token_data: AccessTokenData):
        self.access_tokens[token_data.token] = token_data
    
    def get_access_token(self, token: str) -> Optional[AccessTokenData]:
        token_data = self.access_tokens.get(token)
        if token_data and token_data.expires_at > time.time():
            return token_data
        return None


# Global OAuth store instance
oauth_store = OAuthStore()


def generate_pkce_verifier() -> str:
    """Generate PKCE code verifier"""
    return secrets.token_urlsafe(64)


def generate_pkce_challenge(verifier: str) -> str:
    """Generate PKCE code challenge from verifier (S256 method)"""
    digest = hashlib.sha256(verifier.encode()).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b'=').decode()


def verify_pkce(verifier: str, challenge: str, method: str = "S256") -> bool:
    """Verify PKCE code challenge"""
    if method != "S256":
        return False
    expected = generate_pkce_challenge(verifier)
    return secrets.compare_digest(expected, challenge)


class Auth0TokenVerifier:
    """Verify tokens issued by Auth0"""
    
    def __init__(self, settings: Settings):
        self.settings = settings
        self._jwks_cache = None
        self._jwks_cache_time = 0
        self._jwks_cache_ttl = 3600  # 1 hour
    
    async def get_jwks(self) -> dict:
        """Get Auth0 JWKS with caching"""
        if self._jwks_cache and (time.time() - self._jwks_cache_time) < self._jwks_cache_ttl:
            return self._jwks_cache
        
        async with httpx.AsyncClient() as client:
            response = await client.get(self.settings.auth0_jwks_url)
            response.raise_for_status()
            self._jwks_cache = response.json()
            self._jwks_cache_time = time.time()
            return self._jwks_cache
    
    async def verify_token(self, token: str) -> Optional[Dict[str, Any]]:
        """Verify an Auth0-issued JWT token"""
        try:
            # Get the signing key
            jwks = await self.get_jwks()
            unverified_header = jwt.get_unverified_header(token)
            
            rsa_key = {}
            for key in jwks.get("keys", []):
                if key.get("kid") == unverified_header.get("kid"):
                    rsa_key = {
                        "kty": key["kty"],
                        "kid": key["kid"],
                        "use": key["use"],
                        "n": key["n"],
                        "e": key["e"],
                    }
                    break
            
            if not rsa_key:
                logger.warning("Unable to find appropriate key")
                return None
            
            # Verify the token
            payload = jwt.decode(
                token,
                rsa_key,
                algorithms=["RS256"],
                audience=self.settings.auth0_audience,
                issuer=self.settings.auth0_issuer_url,
            )
            
            return payload
            
        except JWTError as e:
            logger.warning(f"JWT verification failed: {e}")
            return None


class MCPAuthMiddleware:
    """Authentication middleware for MCP endpoints"""
    
    def __init__(self, settings: Settings):
        self.settings = settings
        self.token_verifier = Auth0TokenVerifier(settings)
    
    async def verify_request(
        self,
        request: Request,
        credentials: Optional[HTTPAuthorizationCredentials] = Depends(security)
    ) -> Dict[str, Any]:
        """Verify the request has a valid token"""
        
        # Check for Bearer token
        if not credentials or credentials.scheme.lower() != "bearer":
            raise HTTPException(
                status_code=401,
                detail="Missing or invalid authorization header",
                headers={
                    "WWW-Authenticate": (
                        f'Bearer realm="mcp", '
                        f'resource_metadata="{self.settings.server_url}/.well-known/oauth-protected-resource"'
                    )
                }
            )
        
        token = credentials.credentials
        
        # First try Auth0 verification
        payload = await self.token_verifier.verify_token(token)
        if payload:
            return {
                "user_id": payload.get("sub"),
                "scope": payload.get("scope", ""),
                "email": payload.get("email"),
                "source": "auth0"
            }
        
        # Then try local token store
        token_data = oauth_store.get_access_token(token)
        if token_data:
            return {
                "user_id": token_data.user_id,
                "scope": token_data.scope,
                "client_id": token_data.client_id,
                "source": "local"
            }
        
        raise HTTPException(
            status_code=401,
            detail="Invalid or expired token",
            headers={"WWW-Authenticate": "Bearer error=\"invalid_token\""}
        )


def create_local_jwt(
    settings: Settings,
    user_id: str,
    scope: str,
    client_id: str,
    expires_in: int = 3600
) -> str:
    """Create a local JWT token for the OAuth flow"""
    now = datetime.utcnow()
    payload = {
        "iss": str(settings.server_url),
        "sub": user_id,
        "aud": str(settings.server_url),
        "exp": now + timedelta(seconds=expires_in),
        "iat": now,
        "scope": scope,
        "client_id": client_id,
    }
    
    return jwt.encode(payload, settings.jwt_secret_key, algorithm="HS256")


# Export OAuth metadata endpoints
def get_protected_resource_metadata(settings: Settings) -> dict:
    """RFC 9728 Protected Resource Metadata"""
    return {
        "resource": str(settings.server_url),
        "authorization_servers": [settings.auth0_issuer_url],
        "bearer_methods_supported": ["header"],
        "resource_signing_alg_values_supported": ["RS256"],
        "resource_name": "ConnectWise MCP Server",
        "resource_documentation": f"{settings.server_url}/docs",
        "scopes_supported": [
            "openid",
            "profile",
            "email",
            "mcp:tools:read",
            "mcp:tools:execute"
        ]
    }


def get_authorization_server_metadata(settings: Settings) -> dict:
    """RFC 8414 Authorization Server Metadata"""
    base_url = str(settings.server_url)
    return {
        "issuer": settings.auth0_issuer_url,
        "authorization_endpoint": f"{base_url}/oauth/authorize",
        "token_endpoint": f"{base_url}/oauth/token",
        "registration_endpoint": f"{base_url}/oauth/register",
        "jwks_uri": settings.auth0_jwks_url,
        "scopes_supported": [
            "openid",
            "profile", 
            "email",
            "mcp:tools:read",
            "mcp:tools:execute"
        ],
        "response_types_supported": ["code"],
        "response_modes_supported": ["query"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "token_endpoint_auth_methods_supported": ["client_secret_post", "client_secret_basic"],
        "code_challenge_methods_supported": ["S256"],
        "service_documentation": f"{base_url}/docs"
    }
