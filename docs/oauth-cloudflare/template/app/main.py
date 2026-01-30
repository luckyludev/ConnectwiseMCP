"""
MCP Server with OAuth 2.1 Authentication
Implements MCP Authorization Specification (2025-03-26)
"""
import os
import secrets
import time
import logging
import asyncio
from typing import Optional, Dict, Any
from contextlib import asynccontextmanager
from urllib.parse import urlencode, parse_qs, urlparse

import httpx
from fastapi import FastAPI, Request, Response, HTTPException, Depends, Query, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse, HTMLResponse
from pydantic import BaseModel

from mcp.server.fastmcp import FastMCP
from config import get_settings, Settings
from auth import (
    oauth_store,
    MCPAuthMiddleware,
    get_protected_resource_metadata,
    get_authorization_server_metadata,
    RegisteredClient,
    AuthorizationCode,
    AccessTokenData,
    verify_pkce,
    create_local_jwt,
    security,
)

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Get settings
settings = get_settings()

# Initialize MCP server
mcp = FastMCP(
    name="ConnectWise MCP Server",
    version="1.0.0",
)

# Initialize auth middleware
auth_middleware = MCPAuthMiddleware(settings)


# ============================================================================
# MCP Tools - Your ConnectWise tools go here
# ============================================================================

@mcp.tool()
async def get_tickets(
    status: Optional[str] = None,
    limit: int = 10
) -> Dict[str, Any]:
    """
    Get ConnectWise tickets
    
    Args:
        status: Filter by ticket status (open, closed, etc.)
        limit: Maximum number of tickets to return
    """
    headers = {
        "Authorization": settings.cw_auth_header,
        "clientId": settings.cw_client_id,
        "Content-Type": "application/json",
    }
    
    params = {"pageSize": limit}
    if status:
        params["conditions"] = f"status/name='{status}'"
    
    async with httpx.AsyncClient() as client:
        response = await client.get(
            f"{settings.cw_api_url}/service/tickets",
            headers=headers,
            params=params
        )
        response.raise_for_status()
        return {"tickets": response.json()}


@mcp.tool()
async def get_ticket_by_id(ticket_id: int) -> Dict[str, Any]:
    """
    Get a specific ConnectWise ticket by ID
    
    Args:
        ticket_id: The ticket ID to retrieve
    """
    headers = {
        "Authorization": settings.cw_auth_header,
        "clientId": settings.cw_client_id,
        "Content-Type": "application/json",
    }
    
    async with httpx.AsyncClient() as client:
        response = await client.get(
            f"{settings.cw_api_url}/service/tickets/{ticket_id}",
            headers=headers
        )
        response.raise_for_status()
        return response.json()


@mcp.tool()
async def search_companies(query: str, limit: int = 10) -> Dict[str, Any]:
    """
    Search ConnectWise companies
    
    Args:
        query: Search query string
        limit: Maximum number of results
    """
    headers = {
        "Authorization": settings.cw_auth_header,
        "clientId": settings.cw_client_id,
        "Content-Type": "application/json",
    }
    
    params = {
        "conditions": f"name like '%{query}%'",
        "pageSize": limit
    }
    
    async with httpx.AsyncClient() as client:
        response = await client.get(
            f"{settings.cw_api_url}/company/companies",
            headers=headers,
            params=params
        )
        response.raise_for_status()
        return {"companies": response.json()}


@mcp.tool()
async def get_company_by_id(company_id: int) -> Dict[str, Any]:
    """
    Get a specific ConnectWise company by ID
    
    Args:
        company_id: The company ID to retrieve
    """
    headers = {
        "Authorization": settings.cw_auth_header,
        "clientId": settings.cw_client_id,
        "Content-Type": "application/json",
    }
    
    async with httpx.AsyncClient() as client:
        response = await client.get(
            f"{settings.cw_api_url}/company/companies/{company_id}",
            headers=headers
        )
        response.raise_for_status()
        return response.json()


# ============================================================================
# FastAPI Application
# ============================================================================

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage MCP server lifecycle"""
    async with mcp.session_manager.run():
        logger.info("MCP Server started")
        yield
    logger.info("MCP Server stopped")


app = FastAPI(
    title="ConnectWise MCP Server",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Restrict in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============================================================================
# Health and Discovery Endpoints
# ============================================================================

@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {"status": "healthy", "service": "mcp-oauth-server"}


@app.get("/.well-known/oauth-protected-resource")
async def protected_resource_metadata():
    """RFC 9728 Protected Resource Metadata"""
    return JSONResponse(
        content=get_protected_resource_metadata(settings),
        headers={"Content-Type": "application/json"}
    )


@app.get("/.well-known/oauth-authorization-server")
async def authorization_server_metadata():
    """RFC 8414 Authorization Server Metadata"""
    return JSONResponse(
        content=get_authorization_server_metadata(settings),
        headers={"Content-Type": "application/json"}
    )


# ============================================================================
# OAuth 2.1 Endpoints
# ============================================================================

class ClientRegistrationRequest(BaseModel):
    """RFC 7591 Dynamic Client Registration Request"""
    redirect_uris: list[str]
    client_name: Optional[str] = "MCP Client"
    grant_types: Optional[list[str]] = ["authorization_code", "refresh_token"]
    response_types: Optional[list[str]] = ["code"]
    token_endpoint_auth_method: Optional[str] = "client_secret_post"


@app.post("/oauth/register")
async def register_client(request: ClientRegistrationRequest):
    """RFC 7591 Dynamic Client Registration"""
    client = oauth_store.register_client(request.model_dump())
    
    return JSONResponse(
        content=client.to_dict(),
        status_code=201
    )


@app.get("/oauth/authorize")
async def authorize(
    response_type: str = Query(...),
    client_id: str = Query(...),
    redirect_uri: str = Query(...),
    scope: str = Query("openid profile email"),
    state: Optional[str] = Query(None),
    code_challenge: str = Query(...),
    code_challenge_method: str = Query("S256"),
):
    """OAuth 2.1 Authorization Endpoint with PKCE"""
    
    # Verify client exists
    client = oauth_store.get_client(client_id)
    if not client:
        raise HTTPException(status_code=400, detail="Invalid client_id")
    
    # Verify redirect_uri
    if redirect_uri not in client.redirect_uris:
        raise HTTPException(status_code=400, detail="Invalid redirect_uri")
    
    # Verify PKCE
    if code_challenge_method != "S256":
        raise HTTPException(status_code=400, detail="Only S256 code_challenge_method supported")
    
    # Redirect to Auth0 for authentication
    auth0_params = {
        "response_type": "code",
        "client_id": settings.auth0_client_id,
        "redirect_uri": f"{settings.server_url}/oauth/callback",
        "scope": scope,
        "audience": settings.auth0_audience,
        "state": f"{client_id}:{redirect_uri}:{code_challenge}:{state or ''}",
    }
    
    auth0_url = f"{settings.auth0_authorization_url}?{urlencode(auth0_params)}"
    return RedirectResponse(url=auth0_url)


@app.get("/oauth/callback")
async def oauth_callback(
    code: Optional[str] = Query(None),
    state: Optional[str] = Query(None),
    error: Optional[str] = Query(None),
    error_description: Optional[str] = Query(None),
):
    """OAuth callback from Auth0"""
    
    if error:
        raise HTTPException(status_code=400, detail=f"{error}: {error_description}")
    
    if not code or not state:
        raise HTTPException(status_code=400, detail="Missing code or state")
    
    # Parse state
    try:
        parts = state.split(":")
        client_id = parts[0]
        redirect_uri = parts[1]
        code_challenge = parts[2]
        original_state = parts[3] if len(parts) > 3 else ""
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid state parameter")
    
    # Exchange code with Auth0
    async with httpx.AsyncClient() as client:
        token_response = await client.post(
            settings.auth0_token_url,
            data={
                "grant_type": "authorization_code",
                "client_id": settings.auth0_client_id,
                "client_secret": settings.auth0_client_secret,
                "code": code,
                "redirect_uri": f"{settings.server_url}/oauth/callback",
            }
        )
        
        if token_response.status_code != 200:
            logger.error(f"Auth0 token exchange failed: {token_response.text}")
            raise HTTPException(status_code=400, detail="Token exchange failed")
        
        auth0_tokens = token_response.json()
    
    # Get user info from Auth0
    async with httpx.AsyncClient() as client:
        userinfo_response = await client.get(
            settings.auth0_userinfo_url,
            headers={"Authorization": f"Bearer {auth0_tokens['access_token']}"}
        )
        userinfo = userinfo_response.json() if userinfo_response.status_code == 200 else {}
    
    # Generate our own authorization code
    auth_code = AuthorizationCode(
        code=secrets.token_urlsafe(32),
        client_id=client_id,
        redirect_uri=redirect_uri,
        code_challenge=code_challenge,
        code_challenge_method="S256",
        scope=auth0_tokens.get("scope", ""),
        user_id=userinfo.get("sub", auth0_tokens.get("sub", "unknown")),
        expires_at=time.time() + 600,  # 10 minutes
    )
    
    oauth_store.store_auth_code(auth_code)
    
    # Redirect back to client
    callback_params = {"code": auth_code.code}
    if original_state:
        callback_params["state"] = original_state
    
    callback_url = f"{redirect_uri}?{urlencode(callback_params)}"
    return RedirectResponse(url=callback_url)


@app.post("/oauth/token")
async def token_endpoint(
    grant_type: str = Form(...),
    code: Optional[str] = Form(None),
    redirect_uri: Optional[str] = Form(None),
    client_id: str = Form(...),
    client_secret: Optional[str] = Form(None),
    code_verifier: Optional[str] = Form(None),
    refresh_token: Optional[str] = Form(None),
):
    """OAuth 2.1 Token Endpoint"""
    
    if grant_type == "authorization_code":
        if not code or not code_verifier:
            raise HTTPException(status_code=400, detail="Missing code or code_verifier")
        
        # Retrieve and validate authorization code
        auth_code = oauth_store.get_auth_code(code)
        if not auth_code:
            raise HTTPException(status_code=400, detail="Invalid or expired authorization code")
        
        # Verify client
        if auth_code.client_id != client_id:
            raise HTTPException(status_code=400, detail="Client mismatch")
        
        # Verify PKCE
        if not verify_pkce(code_verifier, auth_code.code_challenge, auth_code.code_challenge_method):
            raise HTTPException(status_code=400, detail="Invalid code_verifier")
        
        # Generate tokens
        access_token = create_local_jwt(
            settings,
            user_id=auth_code.user_id,
            scope=auth_code.scope,
            client_id=client_id,
            expires_in=3600
        )
        
        refresh_token_str = secrets.token_urlsafe(48)
        
        # Store access token
        oauth_store.store_access_token(AccessTokenData(
            token=access_token,
            client_id=client_id,
            user_id=auth_code.user_id,
            scope=auth_code.scope,
            expires_at=time.time() + 3600
        ))
        
        return {
            "access_token": access_token,
            "token_type": "Bearer",
            "expires_in": 3600,
            "refresh_token": refresh_token_str,
            "scope": auth_code.scope,
        }
    
    elif grant_type == "refresh_token":
        # Implement refresh token logic
        raise HTTPException(status_code=400, detail="Refresh token not implemented yet")
    
    else:
        raise HTTPException(status_code=400, detail=f"Unsupported grant_type: {grant_type}")


# ============================================================================
# MCP Endpoints
# ============================================================================

@app.api_route("/mcp", methods=["GET", "POST"])
async def mcp_endpoint(
    request: Request,
    auth_info: Dict[str, Any] = Depends(auth_middleware.verify_request)
):
    """Protected MCP endpoint"""
    logger.info(f"MCP request from user: {auth_info.get('user_id')}")
    
    # Route to MCP server
    return await mcp.handle_streamable_http(request)


@app.api_route("/sse", methods=["GET", "POST"])
async def sse_endpoint(
    request: Request,
    auth_info: Dict[str, Any] = Depends(auth_middleware.verify_request)
):
    """Protected SSE endpoint for MCP"""
    logger.info(f"SSE request from user: {auth_info.get('user_id')}")
    
    # Route to MCP SSE handler
    return await mcp.handle_sse(request)


# ============================================================================
# Test Interface
# ============================================================================

@app.get("/mcp_oauth_test.html")
async def oauth_test_page():
    """OAuth test interface"""
    html_content = """
    <!DOCTYPE html>
    <html>
    <head>
        <title>MCP OAuth Test</title>
        <style>
            body { font-family: Arial, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; }
            button { padding: 10px 20px; margin: 10px; cursor: pointer; }
            pre { background: #f4f4f4; padding: 15px; overflow: auto; }
            .success { color: green; }
            .error { color: red; }
        </style>
    </head>
    <body>
        <h1>MCP OAuth 2.1 Test Interface</h1>
        
        <h2>1. Discovery Endpoints</h2>
        <button onclick="testEndpoint('/.well-known/oauth-protected-resource')">Test Protected Resource Metadata</button>
        <button onclick="testEndpoint('/.well-known/oauth-authorization-server')">Test Authorization Server Metadata</button>
        
        <h2>2. Dynamic Client Registration</h2>
        <button onclick="registerClient()">Register New Client</button>
        
        <h2>3. OAuth Flow</h2>
        <button onclick="startOAuthFlow()">Start OAuth Flow</button>
        
        <h2>4. Test MCP Endpoint</h2>
        <input type="text" id="token" placeholder="Enter access token" style="width: 300px;">
        <button onclick="testMCP()">Test MCP Tools</button>
        
        <h2>Results</h2>
        <pre id="results"></pre>
        
        <script>
            let registeredClient = null;
            
            async function testEndpoint(url) {
                try {
                    const response = await fetch(url);
                    const data = await response.json();
                    document.getElementById('results').innerHTML = 
                        '<span class="success">Success:</span>\\n' + JSON.stringify(data, null, 2);
                } catch (e) {
                    document.getElementById('results').innerHTML = 
                        '<span class="error">Error:</span>\\n' + e.message;
                }
            }
            
            async function registerClient() {
                try {
                    const response = await fetch('/oauth/register', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({
                            redirect_uris: [window.location.origin + '/callback'],
                            client_name: 'Test Client'
                        })
                    });
                    registeredClient = await response.json();
                    document.getElementById('results').innerHTML = 
                        '<span class="success">Client Registered:</span>\\n' + JSON.stringify(registeredClient, null, 2);
                } catch (e) {
                    document.getElementById('results').innerHTML = 
                        '<span class="error">Error:</span>\\n' + e.message;
                }
            }
            
            function startOAuthFlow() {
                if (!registeredClient) {
                    alert('Please register a client first');
                    return;
                }
                
                // Generate PKCE
                const verifier = generateRandomString(64);
                sessionStorage.setItem('pkce_verifier', verifier);
                
                crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
                    .then(hash => {
                        const challenge = btoa(String.fromCharCode(...new Uint8Array(hash)))
                            .replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=/g, '');
                        
                        const params = new URLSearchParams({
                            response_type: 'code',
                            client_id: registeredClient.client_id,
                            redirect_uri: window.location.origin + '/callback',
                            scope: 'openid profile email',
                            state: 'test_state',
                            code_challenge: challenge,
                            code_challenge_method: 'S256'
                        });
                        
                        window.location.href = '/oauth/authorize?' + params.toString();
                    });
            }
            
            async function testMCP() {
                const token = document.getElementById('token').value;
                if (!token) {
                    alert('Please enter an access token');
                    return;
                }
                
                try {
                    const response = await fetch('/mcp', {
                        headers: {'Authorization': 'Bearer ' + token}
                    });
                    const data = await response.json();
                    document.getElementById('results').innerHTML = 
                        '<span class="success">MCP Response:</span>\\n' + JSON.stringify(data, null, 2);
                } catch (e) {
                    document.getElementById('results').innerHTML = 
                        '<span class="error">Error:</span>\\n' + e.message;
                }
            }
            
            function generateRandomString(length) {
                const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
                let result = '';
                const values = crypto.getRandomValues(new Uint8Array(length));
                for (let i = 0; i < length; i++) {
                    result += charset[values[i] % charset.length];
                }
                return result;
            }
            
            // Check for callback code
            const urlParams = new URLSearchParams(window.location.search);
            if (urlParams.get('code')) {
                document.getElementById('results').innerHTML = 
                    '<span class="success">Authorization Code Received:</span>\\n' + urlParams.get('code');
            }
        </script>
    </body>
    </html>
    """
    return HTMLResponse(content=html_content)


# Mount MCP SSE app
app.mount("/", mcp.streamable_http_app())
