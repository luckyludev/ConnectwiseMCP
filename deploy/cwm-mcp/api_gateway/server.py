#!/usr/bin/env python3
"""
API Gateway MCP Server Implementation

Features:
1. Search ConnectWise API endpoints
2. Execute (and optionally bypass-verify) API calls with parameters
3. Send raw API requests
4. Store and retrieve frequently used API queries in Fast Memory
5. Ticket content utilities (notes, attachments, full content)
6. Agreement additions utilities

Note:
- Certain endpoints (e.g. agreement additions) may not appear in your local
  documentation DB; we allow controlled bypass for those.
"""

import os
import sys
import json
import re
import httpx
import asyncio
import base64
import sqlite3
import logging
from typing import Dict, List, Optional, Any
from mcp.server.fastmcp import FastMCP
from api_gateway.api_db_utils import APIDatabase
from api_gateway.fast_memory_db import FastMemoryDB

# Logging setup
log_dir = os.path.dirname(os.path.abspath(__file__))
log_file = os.path.join(log_dir, "api_gateway.log")
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler(log_file),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger("api_gateway")

# MCP server
mcp = FastMCP("api_gateway")

# Global config vars
API_URL = None
COMPANY_ID = None
PUBLIC_KEY = None
PRIVATE_KEY = None
AUTH_PREFIX = None

# Database paths
DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "connectwise_api.db")
FAST_MEMORY_DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fast_memory_api.db")

api_db: Optional[APIDatabase] = None
fast_memory_db: Optional[FastMemoryDB] = None

# Track if current execution originates from Fast Memory
current_query_from_fast_memory = False


class APIError(Exception):
    """Exception raised for API errors."""
    def __init__(self, message, status_code=None, response=None):
        self.message = message
        self.status_code = status_code
        self.response = response
        super().__init__(self.message)


# =========================
# Initialization
# =========================

def setup_config() -> bool:
    """Load configuration from environment variables."""
    global API_URL, COMPANY_ID, PUBLIC_KEY, PRIVATE_KEY, AUTH_PREFIX
    API_URL = os.environ.get('CONNECTWISE_API_URL')
    COMPANY_ID = os.environ.get('CONNECTWISE_COMPANY_ID')
    PUBLIC_KEY = os.environ.get('CONNECTWISE_PUBLIC_KEY')
    PRIVATE_KEY = os.environ.get('CONNECTWISE_PRIVATE_KEY')
    AUTH_PREFIX = os.environ.get('CONNECTWISE_AUTH_PREFIX', '')

    logger.info("ConnectWise API Configuration:")
    logger.info(f"API_URL: {API_URL}")
    logger.info(f"COMPANY_ID: {COMPANY_ID}")
    logger.info(f"PUBLIC_KEY: {PUBLIC_KEY}")
    logger.info(f"PRIVATE_KEY: {'*' * len(PRIVATE_KEY) if PRIVATE_KEY else 'Missing'}")
    logger.info(f"AUTH_PREFIX: {AUTH_PREFIX}")

    if not all([API_URL, COMPANY_ID, PUBLIC_KEY, PRIVATE_KEY]):
        logger.error("Incomplete API configuration. Check environment variables.")
        return False
    return True


def initialize_database() -> bool:
    """Initialize API endpoint documentation database."""
    global api_db
    if not os.path.exists(DB_PATH):
        logger.error(f"Database file not found at {DB_PATH}")
        logger.error("Run build_database.py to generate the database.")
        return False
    try:
        api_db = APIDatabase(DB_PATH)
        logger.info("Connected to API database.")
        return True
    except sqlite3.Error as e:
        logger.error(f"Error connecting to database: {e}")
        return False


def initialize_fast_memory() -> bool:
    """Initialize Fast Memory database."""
    global fast_memory_db
    try:
        fast_memory_db = FastMemoryDB(FAST_MEMORY_DB_PATH)
        logger.info("Connected to Fast Memory database.")
        return True
    except sqlite3.Error as e:
        logger.error(f"Error connecting to Fast Memory database: {e}")
        return False


def get_auth_header() -> Dict[str, str]:
    """Generate authorization headers for ConnectWise API."""
    if not all([COMPANY_ID, PUBLIC_KEY, PRIVATE_KEY]):
        raise APIError("Incomplete API configuration.")
    username = f"{AUTH_PREFIX}{PUBLIC_KEY}"
    credentials = f"{username}:{PRIVATE_KEY}"
    encoded_credentials = base64.b64encode(credentials.encode()).decode()
    return {
        'Authorization': f'Basic {encoded_credentials}',
        'clientId': COMPANY_ID,
        'Content-Type': 'application/json'
    }


# =========================
# Core HTTP Request
# =========================

async def make_api_request(
    method: str,
    endpoint: str,
    params: Optional[Dict[str, Any]] = None,
    data: Optional[Dict[str, Any]] = None,
    headers: Optional[Dict[str, str]] = None
) -> Dict[str, Any]:
    """Perform HTTP request to ConnectWise Manage API."""
    if not API_URL and not setup_config():
        raise APIError("API URL not configured.")
    url = f"{API_URL}{endpoint}"
    headers = headers or get_auth_header()

    logger.info(f"Making {method.upper()} request: {url}")
    if params:
        logger.info(f"Params: {json.dumps(params)}")
    if data:
        logger.info(f"Data: {json.dumps(data)}")

    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            method_upper = method.upper()
            if method_upper == "GET":
                resp = await client.get(url, headers=headers, params=params)
            elif method_upper == "POST":
                resp = await client.post(url, headers=headers, json=data)
            elif method_upper == "PUT":
                resp = await client.put(url, headers=headers, json=data)
            elif method_upper == "PATCH":
                resp = await client.patch(url, headers=headers, json=data)
            elif method_upper == "DELETE":
                resp = await client.delete(url, headers=headers)
            else:
                raise APIError(f"Unsupported HTTP method: {method}")

            logger.info(f"Response status: {resp.status_code}")
            resp.raise_for_status()
            return resp.json() if resp.content else {}
        except httpx.HTTPStatusError as e:
            msg = f"HTTP error {e.response.status_code}: {e.response.text}"
            logger.error(msg)
            raise APIError(msg, status_code=e.response.status_code, response=e.response)
        except httpx.TimeoutException:
            logger.error("Request timed out.")
            raise APIError("Request timed out.")
        except httpx.RequestError as e:
            logger.error(f"Request error: {e}")
            raise APIError(f"API request failed: {e}")
        except Exception as e:
            logger.error(f"Unknown error: {e}")
            raise APIError(f"Unknown error: {e}")


# =========================
# Fast Memory Helpers
# =========================

def check_fast_memory(path: str, method: str) -> Optional[Dict[str, Any]]:
    """Retrieve stored query from Fast Memory."""
    global fast_memory_db, current_query_from_fast_memory
    if not fast_memory_db and not initialize_fast_memory():
        logger.error("Fast Memory initialization failed.")
        return None
    query = fast_memory_db.find_query(path, method)
    if query:
        current_query_from_fast_memory = True
        fast_memory_db.increment_usage(query['id'])
        logger.info(f"Fast Memory hit: {method} {path}")
        return query
    current_query_from_fast_memory = False
    return None


def format_endpoint_for_saving(
    method: str,
    path: str,
    params: Optional[Dict[str, Any]] = None,
    data: Optional[Dict[str, Any]] = None
) -> str:
    """Format a call example for user saving convenience."""
    out = [f"Endpoint: {method.upper()} {path}"]
    if params:
        out.append("\nQuery Parameters:")
        out.append(json.dumps(params, indent=2))
    if data:
        out.append("\nRequest Body:")
        out.append(json.dumps(data, indent=2))
    out.append("\n\nTo save this endpoint to Fast Memory:")
    out.append("```")
    out.append("save_to_fast_memory(")
    out.append(f'    path="{path}",')
    out.append(f'    method="{method}",')
    out.append('    description="YOUR DESCRIPTION HERE",')
    out.append(f"    params={json.dumps(params) if params else 'None'}" +
               ("," if data else ""))
    if data:
        out.append(f"    data={json.dumps(data)}")
    out.append(")")
    out.append("```")
    return "\n".join(out)


# =========================
# MCP Tools
# =========================

@mcp.tool()
async def search_api_endpoints(query: str, max_results: int = 10) -> str:
    if not api_db and not initialize_database():
        return "Error: Failed to initialize API database."
    try:
        results = api_db.search_endpoints(query)
        if not results:
            return "No API endpoints found matching your query."
        lines = []
        for i, endpoint in enumerate(results[:max_results], 1):
            lines.append(f"{i}. {endpoint.get('method','').upper()} {endpoint.get('path','')}\n   {endpoint.get('description','No description available')}")
        resp = "Found the following API endpoints:\n\n" + "\n\n".join(lines)
        if len(results) > max_results:
            resp += f"\n\nShowing {max_results} of {len(results)} results. Refine your search."
        return resp
    except Exception as e:
        logger.error(f"search_api_endpoints error: {e}")
        return f"Error searching API endpoints: {e}"


@mcp.tool()
async def get_api_endpoint_details(path: str, method: str = "GET") -> str:
    if not api_db and not initialize_database():
        return "Error: Failed to initialize API database."
    try:
        endpoint = api_db.find_endpoint_by_path_method(path, method)
        if not endpoint:
            return f"No API endpoint found for {method} {path}."
        return api_db.format_endpoint_for_display(endpoint)
    except Exception as e:
        logger.error(f"get_api_endpoint_details error: {e}")
        return f"Error getting API endpoint details: {e}"


@mcp.tool()
async def execute_api_call(
    path: str,
    method: str = "GET",
    params: Optional[Dict[str, Any]] = None,
    data: Optional[Dict[str, Any]] = None,
    allow_undocumented: bool = False
) -> str:
    """
    Execute an API call.
    - Uses Fast Memory if a stored query matches.
    - Verifies endpoint exists in documentation unless:
        * path matches known special-case patterns (e.g. agreement additions)
        * allow_undocumented=True provided explicitly.
    """
    global current_query_from_fast_memory
    if not api_db and not initialize_database():
        return "Error: Failed to initialize API database."

    # Fast Memory lookup
    fm_entry = check_fast_memory(path, method)
    if fm_entry:
        if params is None and fm_entry.get('params'):
            params = fm_entry['params']
        if data is None and fm_entry.get('data'):
            data = fm_entry['data']

    # Determine whether to bypass documentation verification
    special_bypass = ("/agreements/" in path and "/additions" in path)
    verify_needed = not (special_bypass or allow_undocumented)

    try:
        if verify_needed:
            endpoint = api_db.find_endpoint_by_path_method(path, method)
            if not endpoint:
                return f"Warning: No documented API endpoint found for {method} {path}. You can retry with allow_undocumented=True to force call."
        result = await make_api_request(method, path, params, data)

        # Format response
        if isinstance(result, list):
            if len(result) > 10:
                body = json.dumps(result[:10], indent=2)
                output = f"Retrieved {len(result)} items. Showing first 10:\n\n{body}\n\n(Response truncated.)"
            else:
                output = json.dumps(result, indent=2)
        else:
            output = json.dumps(result, indent=2)

        if not current_query_from_fast_memory:
            save_hint = format_endpoint_for_saving(method, path, params, data)
            output += f"\n\n=== SUCCESSFUL API CALL ===\n{save_hint}\n\nSave this call with save_to_fast_memory if useful."
        else:
            current_query_from_fast_memory = False
            output = f"[Using query from Fast Memory: {fm_entry['description']}]\n\n{output}"

        return output

    except APIError as e:
        current_query_from_fast_memory = False
        return f"API Error ({e.status_code if e.status_code else 'Unknown'}): {e.message}"
    except Exception as e:
        current_query_from_fast_memory = False
        logger.error(f"execute_api_call error: {e}")
        return f"Error executing API call: {e}"


@mcp.tool()
async def natural_language_api_search(query: str, max_results: int = 5) -> str:
    if not api_db and not initialize_database():
        return "Error: Failed to initialize API database."
    try:
        results = api_db.search_by_natural_language(query, max_results)
        if not results:
            return "No API endpoints found matching your query."
        blocks = []
        for i, ep in enumerate(results, 1):
            blocks.append(
                f"{i}. {ep.get('method','').upper()} {ep.get('path','')}\n"
                f"   Category: {ep.get('category','Unknown')}\n"
                f"   Description: {ep.get('description','No description available')}"
            )
        resp = "Based on your query, here are the most relevant API endpoints:\n\n"
        resp += "\n\n".join(blocks)
        resp += "\n\nTo get more details about a specific endpoint, use get_api_endpoint_details."
        return resp
    except Exception as e:
        logger.error(f"natural_language_api_search error: {e}")
        return f"Error searching API endpoints: {e}"


@mcp.tool()
async def list_api_categories() -> str:
    if not api_db and not initialize_database():
        return "Error: Failed to initialize API database."
    try:
        cats = api_db.get_categories()
        if not cats:
            return "No API categories found."
        return "Available API categories:\n\n" + "\n".join(f"- {c}" for c in cats)
    except Exception as e:
        logger.error(f"list_api_categories error: {e}")
        return f"Error listing API categories: {e}"


@mcp.tool()
async def get_category_endpoints(category: str, max_results: int = 20) -> str:
    if not api_db and not initialize_database():
        return "Error: Failed to initialize API database."
    try:
        endpoints = api_db.get_endpoints_by_category(category)
        if not endpoints:
            return f"No endpoints found for category: {category}"
        subset = endpoints[:max_results]
        lines = []
        for i, ep in enumerate(subset, 1):
            lines.append(f"{i}. {ep.get('method','').upper()} {ep.get('path','')}\n   {ep.get('summary','No summary available')}")
        resp = f"Endpoints in category '{category}':\n\n" + "\n\n".join(lines)
        if len(endpoints) > max_results:
            resp += f"\n\nShowing {max_results} of {len(endpoints)}. Increase max_results for more."
        return resp
    except Exception as e:
        logger.error(f"get_category_endpoints error: {e}")
        return f"Error getting category endpoints: {e}"


@mcp.tool()
async def send_raw_api_request(raw_request: str) -> str:
    if not setup_config():
        return "Error: Failed to initialize API configuration."
    try:
        parts = raw_request.strip().split(' ', 2)
        if len(parts) < 2:
            return "Error: Invalid request format. Use 'METHOD /path [JSON body]'"
        method = parts[0].upper()
        path_with_params = parts[1]
        if '?' in path_with_params:
            path, qs = path_with_params.split('?', 1)
            params = {}
            for param in qs.split('&'):
                if '=' in param:
                    k, v = param.split('=', 1)
                    params[k] = v
                else:
                    params[param] = ''
        else:
            path = path_with_params
            params = {}
        data = None
        if len(parts) > 2:
            try:
                data = json.loads(parts[2])
            except json.JSONDecodeError:
                return f"Error: Invalid JSON body: {parts[2]}"
        return await execute_api_call(path, method, params, data)
    except Exception as e:
        logger.error(f"send_raw_api_request error: {e}")
        return f"Error executing raw API request: {e}"


@mcp.tool()
async def save_to_fast_memory(
    path: str,
    method: str,
    description: str,
    params: Optional[Dict[str, Any]] = None,
    data: Optional[Dict[str, Any]] = None
) -> str:
    if not fast_memory_db and not initialize_fast_memory():
        return "Error: Failed to initialize Fast Memory database."
    try:
        qid = fast_memory_db.save_query(description, path, method, params, data)
        return f"Successfully saved query to Fast Memory with ID {qid}."
    except Exception as e:
        logger.error(f"save_to_fast_memory error: {e}")
        return f"Error saving query to Fast Memory: {e}"


@mcp.tool()
async def list_fast_memory(search_term: Optional[str] = None) -> str:
    if not fast_memory_db and not initialize_fast_memory():
        return "Error: Failed to initialize Fast Memory database."
    try:
        if search_term:
            queries = fast_memory_db.search_queries(search_term)
            if not queries:
                return f"No queries found in Fast Memory matching '{search_term}'."
        else:
            queries = fast_memory_db.get_all_queries()
            if not queries:
                return "No queries saved in Fast Memory yet."
        lines = []
        for i, q in enumerate(queries, 1):
            params_str = json.dumps(q.get('params', {}), indent=2) if q.get('params') else "None"
            data_str = json.dumps(q.get('data', {}), indent=2) if q.get('data') else "None"
            if len(params_str) > 100:
                params_str = params_str[:100] + "... (truncated)"
            if len(data_str) > 100:
                data_str = data_str[:100] + "... (truncated)"
            lines.append(
                f"{i}. {q['description']}\n"
                f"   ID: {q['id']}\n"
                f"   Path: {q['method'].upper()} {q['path']}\n"
                f"   Usage Count: {q['usage_count']}\n"
                f"   Parameters: {params_str}\n"
                f"   Data: {data_str}"
            )
        resp = "Queries saved in Fast Memory:\n\n" + "\n\n".join(lines)
        resp += "\n\nTo use a query, call execute_api_call with the same path and method."
        resp += "\nTo delete a query, use delete_from_fast_memory with its ID."
        return resp
    except Exception as e:
        logger.error(f"list_fast_memory error: {e}")
        return f"Error listing Fast Memory queries: {e}"


@mcp.tool()
async def delete_from_fast_memory(query_id: int) -> str:
    if not fast_memory_db and not initialize_fast_memory():
        return "Error: Failed to initialize Fast Memory database."
    try:
        if fast_memory_db.delete_query(query_id):
            return f"Successfully deleted query with ID {query_id}."
        return f"No query found with ID {query_id}."
    except Exception as e:
        logger.error(f"delete_from_fast_memory error: {e}")
        return f"Error deleting query from Fast Memory: {e}"


@mcp.tool()
async def clear_fast_memory() -> str:
    if not fast_memory_db and not initialize_fast_memory():
        return "Error: Failed to initialize Fast Memory database."
    try:
        count = fast_memory_db.clear_all()
        return f"Successfully cleared {count} queries from Fast Memory."
    except Exception as e:
        logger.error(f"clear_fast_memory error: {e}")
        return f"Error clearing Fast Memory: {e}"


# =========================
# Notes / Attachments / Tickets Utilities
# =========================

@mcp.tool()
async def debug_notes_endpoint(ticket_id: int) -> str:
    try:
        ticket_path = f"/service/tickets/{ticket_id}"
        ticket = await make_api_request("GET", ticket_path)
        if not ticket:
            return f"❌ Ticket {ticket_id} not found or inaccessible"
        info = {
            "summary": ticket.get("summary", "No summary"),
            "board": ticket.get("board", {}).get("name", "Unknown"),
            "status": ticket.get("status", {}).get("name", "Unknown"),
            "company": ticket.get("company", {}).get("name", "Unknown"),
            "type": ticket.get("recordType", "Unknown")
        }
        result = [
            f"✅ Ticket {ticket_id} found:",
            f"  Summary: {info['summary']}",
            f"  Board: {info['board']}",
            f"  Status: {info['status']}",
            f"  Company: {info['company']}",
            f"  Type: {info['type']}",
            ""
        ]
        if "_info" in ticket and "notes_href" in ticket["_info"]:
            result.append(f"✅ notes_href present: {ticket['_info']['notes_href']}\n")
        else:
            result.append("❌ No notes_href in ticket response\n")
        result.append("Step 2: Testing notes endpoint variations...")
        test_endpoints = [
            f"/service/tickets/{ticket_id}/notes",
            f"/service/tickets/{ticket_id}/notes/",
            f"/service/serviceTickets/{ticket_id}/notes"
        ]
        for ep in test_endpoints:
            try:
                notes = await make_api_request("GET", ep)
                if isinstance(notes, list):
                    line = f"✅ {ep} - {len(notes)} notes"
                    if notes:
                        first = notes[0]
                        line += f" (first note id={first.get('id','?')}, text_len={len(first.get('text',''))})"
                    result.append(line)
                    return "\n".join(result) + f"\n\n🎉 SUCCESS! Use endpoint: {ep}"
                else:
                    result.append(f"⚠️ {ep} unexpected type {type(notes)}")
            except APIError as e:
                result.append(f"❌ {ep} - {e.status_code}: {e.message}")
        if info["type"] == "ProjectTicket":
            ep = f"/project/tickets/{ticket_id}/notes"
            result.append("\nTesting project ticket notes endpoint...")
            try:
                pnotes = await make_api_request("GET", ep)
                if isinstance(pnotes, list):
                    result.append(f"✅ {ep} - {len(pnotes)} notes")
                    return "\n".join(result) + f"\n\n🎉 SUCCESS! Use endpoint: {ep}"
                else:
                    result.append(f"⚠️ {ep} unexpected type {type(pnotes)}")
            except APIError as e:
                result.append(f"❌ {ep} - {e.status_code}: {e.message}")
        result.append("\n❌ CONCLUSION: Notes endpoint not accessible via tested paths")
        result.append("Possible causes:")
        result.append("1. Permissions")
        result.append("2. Board settings")
        result.append("3. Version differences")
        result.append("4. Alternate endpoint path")
        return "\n".join(result)
    except Exception as e:
        return f"❌ Error during notes debugging: {e}"


@mcp.tool()
async def try_notes_with_conditions(ticket_id: int) -> str:
    result = [f"Testing notes access for ticket {ticket_id}...\n"]
    tests = [
        ("Basic request", None),
        ("With pageSize", {"pageSize": 10}),
        ("With conditions", {"conditions": "id > 0"}),
        ("With fields", {"fields": "id,text,dateCreated"}),
        ("With orderBy", {"orderBy": "dateCreated"}),
        ("Internal only", {"conditions": "internalAnalysisFlag=true"}),
        ("External only", {"conditions": "internalAnalysisFlag=false"}),
    ]
    base = f"/service/tickets/{ticket_id}/notes"
    for desc, p in tests:
        try:
            r = await make_api_request("GET", base, params=p)
            if isinstance(r, list):
                line = f"✅ {desc}: {len(r)} notes"
                if r and desc == "Basic request":
                    line += f" (sample keys: {list(r[0].keys())[:5]})"
                result.append(line)
            else:
                result.append(f"⚠️ {desc}: unexpected type {type(r)}")
        except APIError as e:
            result.append(f"❌ {desc}: {e.status_code} - {e.message}")
        except Exception as e:
            result.append(f"❌ {desc}: Exception {e}")
    return "\n".join(result)


@mcp.tool()
async def check_api_user_permissions() -> str:
    tests = [
        ("/system/members", "System members"),
        ("/system/myMember", "Current user info"),
        ("/service/boards", "Service boards"),
        ("/service/sources", "Service sources"),
        ("/service/priorities", "Service priorities"),
        ("/service/statuses", "Service statuses"),
        ("/service/tickets", "Service tickets", {"pageSize": 1})
    ]
    lines = ["Checking API user permissions...\n"]
    for item in tests:
        path, desc = item[0], item[1]
        params = item[2] if len(item) > 2 else None
        try:
            r = await make_api_request("GET", path, params=params)
            if isinstance(r, list):
                lines.append(f"✅ {desc}: Access granted ({len(r)} items)")
            elif isinstance(r, dict):
                lines.append(f"✅ {desc}: Access granted (object response)")
            else:
                lines.append(f"⚠️ {desc}: Unusual response type {type(r)}")
        except APIError as e:
            if e.status_code == 403:
                lines.append(f"❌ {desc}: Forbidden")
            elif e.status_code == 401:
                lines.append(f"❌ {desc}: Unauthorized")
            else:
                lines.append(f"❌ {desc}: Error {e.status_code}")
        except Exception as e:
            lines.append(f"❌ {desc}: Exception {e}")
    return "\n".join(lines)


@mcp.tool()
async def test_notes_crud_operations(ticket_id: int) -> str:
    out = [f"Testing CRUD for notes on ticket {ticket_id}...\n"]
    base = f"/service/tickets/{ticket_id}/notes"

    # READ
    out.append("Step 1: READ")
    try:
        existing = await make_api_request("GET", base)
        if isinstance(existing, list):
            out.append(f"✅ READ: {len(existing)} notes")
            original_count = len(existing)
        else:
            out.append(f"⚠️ READ: Unexpected type {type(existing)}")
            original_count = 0
    except APIError as e:
        out.append(f"❌ READ failed: {e.status_code} {e.message}")
        return "\n".join(out) + "\nCannot continue without READ."

    # CREATE
    out.append("\nStep 2: CREATE")
    note_payload = {
        "text": "API Test Note - Created by debug function",
        "internalAnalysisFlag": True,
        "detailDescriptionFlag": False
    }
    created_id = None
    try:
        created = await make_api_request("POST", base, data=note_payload)
        if isinstance(created, dict) and "id" in created:
            created_id = created["id"]
            out.append(f"✅ CREATE: Note ID {created_id}")
        else:
            out.append(f"⚠️ CREATE: Unexpected response {created}")
    except APIError as e:
        out.append(f"❌ CREATE failed: {e.status_code} {e.message}")

    # UPDATE
    if created_id:
        out.append("\nStep 3: UPDATE")
        try:
            await make_api_request("PATCH", f"{base}/{created_id}", data={
                "text": "API Test Note - Updated by debug function",
                "internalAnalysisFlag": True
            })
            out.append(f"✅ UPDATE: Note {created_id}")
        except APIError as e:
            out.append(f"❌ UPDATE failed: {e.status_code} {e.message}")

    # DELETE
    if created_id:
        out.append("\nStep 4: DELETE")
        try:
            await make_api_request("DELETE", f"{base}/{created_id}")
            out.append(f"✅ DELETE: Note {created_id}")
        except APIError as e:
            out.append(f"❌ DELETE failed: {e.status_code} {e.message}")

    # VERIFY
    out.append("\nStep 5: VERIFY")
    try:
        final_notes = await make_api_request("GET", base)
        if isinstance(final_notes, list):
            final_count = len(final_notes)
            if final_count == original_count:
                out.append(f"✅ VERIFICATION: Count restored ({final_count})")
            else:
                out.append(f"⚠️ VERIFICATION: Count changed {original_count} -> {final_count}")
    except APIError as e:
        out.append(f"❌ VERIFICATION failed: {e.message}")

    return "\n".join(out)


def handle_notes_specific_errors(response, endpoint_path):
    """Optional specialized notes error messaging (not wired into make_api_request global error path)."""
    if "/notes" in endpoint_path:
        if response.status_code == 403:
            return "Notes access forbidden. Check permissions/board settings."
        if response.status_code == 404:
            return "Notes endpoint not found for this ticket."
        if response.status_code == 400:
            return "Bad request for notes. Verify parameters."
    return None


@mcp.tool()
async def get_ticket_notes_with_content(ticket_id: int, include_internal: bool = True, include_external: bool = True) -> str:
    try:
        header = [f"📝 Notes for Ticket #{ticket_id}", "=" * 50, ""]
        try:
            t = await make_api_request("GET", f"/service/tickets/{ticket_id}")
            header.append(f"**Ticket:** {t.get('summary','No summary')}")
            header.append(f"**Company:** {t.get('company',{}).get('name','Unknown')}")
            header.append(f"**Status:** {t.get('status',{}).get('name','Unknown')}\n")
        except APIError:
            header.append(f"**Ticket:** {ticket_id} (details not accessible)\n")

        endpoints = [
            f"/service/tickets/{ticket_id}/notes",
            f"/project/tickets/{ticket_id}/notes"
        ]
        notes_all = []
        for ep in endpoints:
            try:
                r = await make_api_request("GET", ep)
                if isinstance(r, list) and r:
                    notes_all = r
                    break
            except APIError:
                continue
        if not notes_all:
            header.append("❌ **No notes found or not accessible**")
            header.append("Possible reasons:\n• Permissions\n• No notes exist\n• Endpoint variant not supported")
            return "\n".join(header)

        filtered = []
        for n in notes_all:
            internal = n.get('internalFlag', n.get('internalAnalysisFlag', False))
            external = n.get('externalFlag', not internal)
            if (include_internal and internal) or (include_external and external):
                filtered.append(n)

        if not filtered:
            header.append("❌ **No notes found matching criteria**")
            return "\n".join(header)

        filtered.sort(key=lambda x: x.get('dateCreated', ''))

        header.append(f"**Found {len(filtered)} notes** (Total: {len(notes_all)})\n")
        for i, note in enumerate(filtered, 1):
            internal = note.get('internalFlag', note.get('internalAnalysisFlag', False))
            visibility = "Internal" if internal else "External/Customer"
            flags = []
            if note.get('resolutionFlag'):
                flags.append("Resolution")
            if note.get('issueFlag'):
                flags.append("Issue")
            if note.get('detailDescriptionFlag'):
                flags.append("Detail Description")
            block = [
                f"### Note #{i}",
                f"**ID:** {note.get('id','?')}",
                f"**Created:** {note.get('dateCreated','Unknown')}",
                f"**Created By:** {note.get('createdBy','Unknown')}",
                f"**Visibility:** {visibility}"
            ]
            if flags:
                block.append(f"**Flags:** {', '.join(flags)}")
            if note.get('contact'):
                block.append(f"**Contact:** {note['contact'].get('name','Unknown')}")
            text = note.get('text','')
            block.append("**Text:**" + ("\n```\n" + text + "\n```" if text else " (No text)"))
            block.append("\n" + "-" * 40 + "\n")
            header.extend(block)
        return "\n".join(header)
    except Exception as e:
        return f"❌ Error retrieving notes: {e}"


@mcp.tool()
async def get_ticket_attachments_with_details(ticket_id: int, download_info: bool = True) -> str:
    try:
        lines = [f"📎 Attachments for Ticket #{ticket_id}", "=" * 50, ""]
        docs = await make_api_request(
            "GET",
            "/system/documents",
            params={"recordType": "Ticket", "recordId": str(ticket_id)}
        )
        if not docs:
            lines.append("❌ **No attachments found for this ticket**")
            return "\n".join(lines)
        lines.append(f"**Found {len(docs)} attachment(s)**\n")
        total_size = 0
        for i, doc in enumerate(docs, 1):
            size = doc.get('size', 0)
            total_size += size
            if size < 1024:
                size_str = f"{size} bytes"
            elif size < 1024 * 1024:
                size_str = f"{size/1024:.1f} KB"
            else:
                size_str = f"{size/(1024*1024):.1f} MB"
            flags = []
            for k, label in [
                ('publicFlag', 'Public'),
                ('readOnlyFlag', 'Read-Only'),
                ('linkFlag', 'Link'),
                ('imageFlag', 'Image'),
                ('htmlTemplateFlag', 'HTML Template')
            ]:
                if doc.get(k):
                    flags.append(label)
            block = [
                f"### Attachment #{i}",
                f"**ID:** {doc.get('id','?')}",
                f"**Title:** {doc.get('title','No title')}",
                f"**Filename:** {doc.get('fileName','Unknown')}",
                f"**Size:** {size_str}",
                f"**Type:** {doc.get('documentType',{}).get('name','Unknown')}",
                f"**Owner:** {doc.get('owner','Unknown')}",
                f"**Created:** {doc.get('createdOnDate','Unknown')}",
                f"**Updated:** {doc.get('_info',{}).get('lastUpdated','Unknown')}",
            ]
            if flags:
                block.append(f"**Properties:** {', '.join(flags)}")
            if download_info and doc.get('id'):
                block.append(f"**Download URL:** `/system/documents/{doc['id']}/download`")
                if doc.get('imageFlag'):
                    block.append(f"**Thumbnail URL:** `/system/documents/{doc['id']}/thumbnail`")
            if doc.get('guid'):
                block.append(f"**GUID:** {doc.get('guid')}")
            block.append("\n" + "-" * 40 + "\n")
            lines.extend(block)
        if total_size:
            if total_size < 1024 * 1024:
                tsize_str = f"{total_size/1024:.1f} KB"
            else:
                tsize_str = f"{total_size/(1024*1024):.1f} MB"
            lines.append(f"**Total Size:** {tsize_str}\n")
        if download_info:
            lines.append("### 📥 Download Instructions")
            lines.append("```\nexecute_api_call(\n    path='/system/documents/{document_id}/download',\n    method='GET'\n)\n```")
        return "\n".join(lines)
    except APIError as e:
        return f"❌ API Error getting attachments: {e.message}"
    except Exception as e:
        return f"❌ Error retrieving attachments: {e}"


@mcp.tool()
async def get_complete_ticket_content(ticket_id: int) -> str:
    try:
        parts = [f"🎫 Complete Content for Ticket #{ticket_id}", "=" * 60, ""]
        parts.append("## 📋 Ticket Details")
        try:
            t = await make_api_request("GET", f"/service/tickets/{ticket_id}")
            parts.extend([
                f"**Summary:** {t.get('summary','No summary')}",
                f"**Company:** {t.get('company',{}).get('name','Unknown')}",
                f"**Board:** {t.get('board',{}).get('name','Unknown')}",
                f"**Status:** {t.get('status',{}).get('name','Unknown')}",
                f"**Priority:** {t.get('priority',{}).get('name','Unknown')}",
                f"**Type:** {t.get('type',{}).get('name','Unknown')}",
            ])
            if t.get('contact'):
                email = t['contact'].get('contactEmailAddress') or t.get('contactEmailAddress')
                parts.append(f"**Contact:** {t['contact'].get('name','Unknown')}" + (f" ({email})" if email else ""))
            parts.extend([
                f"**Created:** {t.get('_info',{}).get('dateEntered','Unknown')}",
                f"**Updated:** {t.get('_info',{}).get('lastUpdated','Unknown')}",
                f"**Entered By:** {t.get('_info',{}).get('enteredBy','Unknown')}",
            ])
            if t.get('owner'):
                parts.append(f"**Owner:** {t['owner'].get('name','Unknown')}")
            if t.get('resources'):
                parts.append(f"**Resources:** {t.get('resources')}")
            parts.append("")
        except APIError as e:
            parts.append(f"❌ Could not retrieve ticket details: {e.message}\n")

        parts.append("## 📝 Notes")
        try:
            notes_block = await get_ticket_notes_with_content(ticket_id)
            parts.append(notes_block.split("=", 1)[-1].strip() if "📝 Notes" in notes_block else notes_block)
        except Exception as e:
            parts.append(f"❌ Error retrieving notes: {e}")
        parts.append("")

        parts.append("## 📎 Attachments")
        try:
            attach_block = await get_ticket_attachments_with_details(ticket_id)
            parts.append(attach_block.split("=", 1)[-1].strip() if "📎 Attachments" in attach_block else attach_block)
        except Exception as e:
            parts.append(f"❌ Error retrieving attachments: {e}")
        parts.append("")

        parts.append("## ⏰ Time Entries")
        try:
            time_entries = await make_api_request(
                "GET",
                "/time/entries",
                params={
                    "conditions": f"(chargeToType='ServiceTicket' OR chargeToType='ProjectTicket') AND chargeToId={ticket_id}",
                    "pageSize": 10,
                    "orderBy": "dateEntered desc"
                }
            )
            if time_entries:
                parts.append(f"**Found {len(time_entries)} time entries**\n")
                for i, te in enumerate(time_entries[:5], 1):
                    parts.extend([
                        f"### Time Entry #{i}",
                        f"**Hours:** {te.get('actualHours',0)}",
                        f"**Date:** {te.get('timeStart','Unknown')}",
                        f"**Member:** {te.get('member',{}).get('name','Unknown')}",
                        f"**Notes:** {te.get('notes','No notes')}",
                        f"**Work Type:** {te.get('workType',{}).get('name','Unknown')}",
                        ""
                    ])
                if len(time_entries) > 5:
                    parts.append(f"... and {len(time_entries)-5} more time entries")
            else:
                parts.append("No time entries found")
        except Exception as e:
            parts.append(f"❌ Error retrieving time entries: {e}")
        parts.append("")

        parts.append("## ✅ Tasks")
        try:
            tasks = await make_api_request("GET", f"/service/tickets/{ticket_id}/tasks")
            if tasks:
                parts.append(f"**Found {len(tasks)} tasks**\n")
                for i, task in enumerate(tasks, 1):
                    parts.extend([
                        f"### Task #{i}",
                        f"**Summary:** {task.get('summary','No summary')}",
                        f"**Priority:** {task.get('priority',{}).get('name','Unknown')}",
                        f"**Status:** {task.get('status',{}).get('name','Unknown')}",
                        f"**Due Date:** {task.get('dueDate','No due date')}",
                        f"**Notes:** {task.get('notes','No notes')}" if task.get('notes') else "",
                        ""
                    ])
            else:
                parts.append("No tasks found")
        except Exception as e:
            parts.append(f"❌ Error retrieving tasks: {e}")
        parts.append("")
        parts.append("## 📊 Content Summary")
        parts.append(f"Collected details, notes, attachments, time entries, tasks for ticket #{ticket_id}.")
        return "\n".join(parts)
    except Exception as e:
        return f"❌ Error generating complete ticket content: {e}"


@mcp.tool()
async def download_ticket_attachment(ticket_id: int, document_id: int, save_path: Optional[str] = None) -> str:
    try:
        meta = await make_api_request("GET", f"/system/documents/{document_id}")
        if not meta:
            return f"❌ Document {document_id} not found"
        filename = meta.get('fileName', f'document_{document_id}')
        size = meta.get('size', 0)
        res = [
            f"📥 Downloading: {filename}",
            f"Document ID: {document_id}",
            f"Size: {size} bytes",
            ""
        ]
        dl = await make_api_request("GET", f"/system/documents/{document_id}/download")
        res.append("✅ Download completed successfully")
        if save_path:
            res.append(f"File would be saved to: {save_path}")
        else:
            res.append(f"File content available (representation length: {len(str(dl))} chars)")
        res.append("\nNote: Handle binary content as needed in a real implementation.")
        return "\n".join(res)
    except APIError as e:
        return f"❌ Download failed: {e.message}"
    except Exception as e:
        return f"❌ Error downloading attachment: {e}"


@mcp.tool()
async def create_ticket_note(
    ticket_id: int,
    text: str,
    internal_only: bool = True,
    resolution_note: bool = False,
    issue_note: bool = False
) -> str:
    try:
        payload = {
            "text": text,
            "internalAnalysisFlag": internal_only,
            "externalFlag": not internal_only,
            "resolutionFlag": resolution_note,
            "issueFlag": issue_note,
            "detailDescriptionFlag": False
        }
        try:
            created = await make_api_request("POST", f"/service/tickets/{ticket_id}/notes", data=payload)
        except APIError:
            created = await make_api_request("POST", f"/project/tickets/{ticket_id}/notes", data=payload)
        if created and "id" in created:
            types = []
            if resolution_note:
                types.append("Resolution")
            if issue_note:
                types.append("Issue")
            if not types:
                types.append("General")
            return (
                f"✅ Successfully created note on ticket #{ticket_id}\n"
                f"Note ID: {created['id']}\n"
                f"Visibility: {'Internal' if internal_only else 'External/Customer'}\n"
                f"Type: {', '.join(types)}\n"
                f"Text Length: {len(text)} characters"
            )
        return f"⚠️ Unexpected response: {created}"
    except APIError as e:
        return f"❌ Failed to create note: {e.message}"
    except Exception as e:
        return f"❌ Error creating note: {e}"


@mcp.tool()
async def search_tickets_by_content(
    search_text: str,
    search_notes: bool = True,
    search_summary: bool = True,
    max_results: int = 10
) -> str:
    try:
        lines = [f"🔍 Searching for: '{search_text}'", "=" * 50, ""]
        matches = []
        if search_summary:
            try:
                tickets = await make_api_request(
                    "GET",
                    "/service/tickets",
                    params={
                        "conditions": f"summary contains '{search_text}'",
                        "pageSize": max_results,
                        "orderBy": "dateEntered desc"
                    }
                )
                for t in tickets:
                    matches.append({"ticket": t, "match_type": "Summary"})
            except APIError as e:
                lines.append(f"⚠️ Summary search failed: {e.message}")
        if search_notes and len(matches) < max_results:
            lines.append("Note: Full note text search requires per-ticket retrieval (not performed here).")
        if not matches:
            lines.append(f"❌ No tickets found containing '{search_text}'")
            return "\n".join(lines)
        lines.append(f"**Found {len(matches)} tickets**\n")
        for i, m in enumerate(matches[:max_results], 1):
            t = m["ticket"]
            lines.extend([
                f"### {i}. Ticket #{t.get('id')}",
                f"**Summary:** {t.get('summary','No summary')}",
                f"**Company:** {t.get('company',{}).get('name','Unknown')}",
                f"**Status:** {t.get('status',{}).get('name','Unknown')}",
                f"**Match Type:** {m['match_type']}",
                f"**Created:** {t.get('_info',{}).get('dateEntered','Unknown')}",
                ""
            ])
        return "\n".join(lines)
    except Exception as e:
        return f"❌ Error searching tickets: {e}"


# =========================
# Agreement Additions
# =========================

@mcp.tool()
async def get_agreement_additions(agreement_id: int, include_details: bool = True) -> str:
    try:
        lines = [f"📋 Agreement Additions for Agreement #{agreement_id}", "=" * 60, ""]
        try:
            agr = await make_api_request("GET", f"/finance/agreements/{agreement_id}")
            lines.extend([
                f"**Agreement:** {agr.get('name','Unknown')}",
                f"**Type:** {agr.get('type',{}).get('name','Unknown')}",
                f"**Company:** {agr.get('company',{}).get('name','Unknown')}",
                f"**Status:** {agr.get('agreementStatus','Unknown')}",
                ""
            ])
        except APIError as e:
            lines.append(f"**Agreement:** {agreement_id} (details not accessible: {e.message})\n")

        path = f"/finance/agreements/{agreement_id}/additions"
        try:
            additions = await make_api_request("GET", path)
            if not additions:
                lines.append("❌ **No additions found for this agreement**")
                lines.append("Possible reasons:\n• None configured\n• Uses child agreements\n• Permission limitations")
                return "\n".join(lines)
            if not isinstance(additions, list):
                lines.append(f"⚠️ Unexpected response type: {type(additions)}")
                lines.append(f"Raw: {additions}")
                return "\n".join(lines)

            lines.append(f"**Found {len(additions)} addition(s)**\n")
            total = 0
            for i, add in enumerate(additions, 1):
                qty = add.get('quantity', 0)
                unit_price = add.get('unitPrice', 0)
                ext_price = add.get('extendedPrice', 0)
                total += ext_price
                block = [
                    f"### Addition #{i}",
                    f"**ID:** {add.get('id','?')}",
                ]
                if add.get('product'):
                    block.append(f"**Product:** {add['product'].get('name','Unknown')} (ID {add['product'].get('id','?')})")
                block.extend([
                    f"**Quantity:** {qty}",
                    f"**Unit Price:** ${unit_price:,.2f}",
                    f"**Extended Price:** ${ext_price:,.2f}",
                ])
                if add.get('effectiveDate'):
                    block.append(f"**Effective Date:** {add.get('effectiveDate')}")
                if add.get('cancelledDate'):
                    block.append(f"**Cancelled Date:** {add.get('cancelledDate')}")
                if add.get('billableOption'):
                    block.append(f"**Billable Option:** {add.get('billableOption')}")
                if include_details and add.get('cost', 0) > 0:
                    cost = add.get('cost', 0)
                    margin = ext_price - (cost * qty)
                    block.append(f"**Cost:** ${cost:,.2f}")
                    block.append(f"**Margin:** ${margin:,.2f}")
                if add.get('description'):
                    block.append(f"**Description:** {add.get('description')}")
                if add.get('customFields'):
                    block.append(f"**Custom Fields:** {len(add.get('customFields'))} field(s)")
                block.append("\n" + "-" * 50 + "\n")
                lines.extend(block)
            lines.append("## 💰 Summary")
            lines.append(f"**Total Additions:** {len(additions)}")
            lines.append(f"**Total Amount:** ${total:,.2f}")
            return "\n".join(lines)
        except APIError as e:
            err = [f"❌ API Error accessing additions: {e.message}", ""]
            if e.status_code == 404:
                err.append("Possible causes:\n• Endpoint unsupported\n• Invalid agreement ID")
            elif e.status_code == 403:
                err.append("Possible causes:\n• Permission denied")
            elif e.status_code == 500:
                err.append("Server error within ConnectWise")
            err.append(f"\nHTTP Status: {e.status_code}")
            return "\n".join(err)
    except Exception as e:
        return f"❌ Error retrieving agreement additions: {e}"


@mcp.tool()
async def get_agreement_additions_summary(agreement_id: int) -> str:
    try:
        try:
            cnt_resp = await make_api_request("GET", f"/finance/agreements/{agreement_id}/additions/count")
            count = cnt_resp.get('count', 0) if isinstance(cnt_resp, dict) else 0
        except APIError:
            count = 0
        lines = [f"📊 Agreement Additions Summary - Agreement #{agreement_id}", "=" * 60, ""]
        if count == 0:
            lines.append("**No additions found**\nPossible reasons:\n• None configured\n• Uses child agreements\n• Inaccessible via API")
            return "\n".join(lines)
        lines.append(f"**Total Additions:** {count}\n")
        detail = await get_agreement_additions(agreement_id, include_details=True)
        if "💰 Summary" in detail:
            summary_start = detail.find("## 💰 Summary")
            lines.append(detail[summary_start:])
        else:
            lines.append("Could not extract detailed summary.")
        return "\n".join(lines)
    except Exception as e:
        return f"❌ Error retrieving agreement additions summary: {e}"


@mcp.tool()
async def create_agreement_addition(
    agreement_id: int,
    product_id: int,
    quantity: float,
    unit_price: float,
    effective_date: str,
    description: Optional[str] = None,
    billable_option: str = "Billable"
) -> str:
    try:
        payload = {
            "product": {"id": product_id},
            "quantity": quantity,
            "unitPrice": unit_price,
            "effectiveDate": effective_date,
            "billableOption": billable_option
        }
        if description:
            payload["description"] = description
        created = await make_api_request("POST", f"/finance/agreements/{agreement_id}/additions", data=payload)
        if created and "id" in created:
            ext_price = created.get("extendedPrice", quantity * unit_price)
            return (
                "✅ Successfully created agreement addition\n"
                f"Addition ID: {created['id']}\n"
                f"Agreement: {agreement_id}\n"
                f"Product ID: {product_id}\n"
                f"Quantity: {quantity}\n"
                f"Unit Price: ${unit_price:,.2f}\n"
                f"Extended Price: ${ext_price:,.2f}\n"
                f"Effective Date: {effective_date}\n"
                f"Billable Option: {billable_option}"
            )
        return f"⚠️ Unexpected response: {created}"
    except APIError as e:
        return f"❌ Failed to create agreement addition: {e.message}"
    except Exception as e:
        return f"❌ Error creating agreement addition: {e}"


@mcp.tool()
async def search_agreement_additions(
    company_id: Optional[int] = None,
    product_name: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    max_results: int = 20
) -> str:
    try:
        lines = ["🔍 Searching Agreement Additions", "=" * 50, "", "**Search Criteria:**"]
        if company_id:
            lines.append(f"• Company ID: {company_id}")
        if product_name:
            lines.append(f"• Product Name: {product_name}")
        if date_from:
            lines.append(f"• Date From: {date_from}")
        if date_to:
            lines.append(f"• Date To: {date_to}")
        lines.append("\nNote: Cross-agreement direct addition search may not be supported.")
        lines.append("Consider targeted use of get_agreement_additions for specific agreements.\n")
        if company_id:
            try:
                agreements = await make_api_request(
                    "GET",
                    "/finance/agreements",
                    params={"conditions": f"company/id={company_id}", "pageSize": 50}
                )
                lines.append(f"Found {len(agreements)} agreements for company {company_id}\n")
                total_additions = 0
                for agr in agreements:
                    agr_id = agr.get("id")
                    agr_name = agr.get("name", "Unknown")
                    try:
                        adds = await make_api_request("GET", f"/finance/agreements/{agr_id}/additions")
                        if adds:
                            total_additions += len(adds)
                            lines.append(f"• {agr_name} (ID {agr_id}): {len(adds)} additions")
                    except APIError:
                        lines.append(f"• {agr_name} (ID {agr_id}): additions inaccessible")
                lines.append(f"\nTotal additions found (raw count sum): {total_additions}")
            except APIError as e:
                lines.append(f"\n❌ Error retrieving agreements: {e.message}")
        return "\n".join(lines)
    except Exception as e:
        return f"❌ Error searching agreement additions: {e}"


@mcp.tool()
async def get_agreement_billing_summary(agreement_id: int) -> str:
    try:
        lines = [f"💰 Agreement Billing Summary - Agreement #{agreement_id}", "=" * 60, ""]
        try:
            agr = await make_api_request("GET", f"/finance/agreements/{agreement_id}")
            lines.extend([
                f"**Agreement:** {agr.get('name','Unknown')}",
                f"**Type:** {agr.get('type',{}).get('name','Unknown')}",
                f"**Company:** {agr.get('company',{}).get('name','Unknown')}",
                f"**Status:** {agr.get('agreementStatus','Unknown')}",
                f"**Billing Cycle:** {agr.get('billingCycle',{}).get('name','Unknown')}",
                f"**Bill Amount:** ${agr.get('billAmount',0):,.2f}",
                f"**Next Invoice:** {agr.get('nextInvoiceDate','Unknown')}",
                ""
            ])
        except APIError:
            lines.append(f"**Agreement:** {agreement_id} (details not accessible)\n")
        lines.append("## 📋 Additions Summary")
        add_sum = await get_agreement_additions_summary(agreement_id)
        if "Total Additions:" in add_sum:
            for line in add_sum.splitlines():
                if "Total Additions:" in line or "Total Amount:" in line:
                    lines.append(line)
        else:
            lines.append("No additions found")
        lines.append("\n## 🧾 Recent Invoices")
        try:
            invoices = await make_api_request(
                "GET",
                "/finance/invoices",
                params={
                    "conditions": f"agreement/id={agreement_id}",
                    "pageSize": 5,
                    "orderBy": "date desc"
                }
            )
            if invoices:
                lines.append(f"Found {len(invoices)} recent invoices\n")
                for inv in invoices:
                    lines.append(f"• {inv.get('invoiceNumber','Unknown')} - ${inv.get('total',0):,.2f} - {inv.get('date','Unknown')}")
            else:
                lines.append("No recent invoices found")
        except APIError as e:
            lines.append(f"Could not retrieve invoices: {e.message}")
        return "\n".join(lines)
    except Exception as e:
        return f"❌ Error retrieving agreement billing summary: {e}"


# =========================
# Main Entry
# =========================

def main():
    logger.info("Starting ConnectWise API Gateway MCP Server...")
    setup_config()
    initialize_database()
    initialize_fast_memory()
    mcp.run(transport='stdio')


if __name__ == "__main__":
    main()
