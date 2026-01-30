#!/usr/bin/env python3
"""
API Gateway MCP Server Implementation

This module implements a Model Context Protocol server that allows:
1. Searching for ConnectWise API endpoints
2. Executing API calls with parameters
3. Sending raw API requests
4. Storing and retrieving frequently used API queries in Fast Memory
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
from typing import Dict, List, Optional, Any, Union
from mcp.server.fastmcp import FastMCP
from api_gateway.api_db_utils import APIDatabase
from api_gateway.fast_memory_db import FastMemoryDB

# Set up logging
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

# Initialize FastMCP server
mcp = FastMCP("api_gateway")

# Global variables
API_URL = None  # Will be set from environment
COMPANY_ID = None
PUBLIC_KEY = None
PRIVATE_KEY = None
AUTH_PREFIX = None  # Will be set from environment
DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "connectwise_api.db")
FAST_MEMORY_DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fast_memory_api.db")
api_db = None
fast_memory_db = None

# Track if a query came from Fast Memory to avoid asking to save it again
current_query_from_fast_memory = False

class APIError(Exception):
    """Exception raised for API errors"""
    def __init__(self, message, status_code=None, response=None):
        self.message = message
        self.status_code = status_code
        self.response = response
        super().__init__(self.message)

# Initialization Functions

def setup_config():
    """Set up API configuration from environment variables"""
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
        logger.error("ConnectWise API configuration incomplete. Please check environment variables.")
        return False
    return True

def initialize_database():
    """Initialize the API database connection"""
    global api_db
    
    # Check if database exists
    if not os.path.exists(DB_PATH):
        logger.error(f"Database file not found at {DB_PATH}")
        logger.error("Please run build_database.py script first to generate the database")
        return False
    
    # Connect to the database
    try:
        api_db = APIDatabase(DB_PATH)
        logger.info("Connected to API database.")
        return True
    except sqlite3.Error as e:
        logger.error(f"Error connecting to database: {e}")
        return False

def initialize_fast_memory():
    """Initialize the Fast Memory database connection"""
    global fast_memory_db
    
    try:
        fast_memory_db = FastMemoryDB(FAST_MEMORY_DB_PATH)
        logger.info("Connected to Fast Memory database.")
        return True
    except sqlite3.Error as e:
        logger.error(f"Error connecting to Fast Memory database: {e}")
        return False

def get_auth_header():
    """Create authorization header for ConnectWise API"""
    if not all([COMPANY_ID, PUBLIC_KEY, PRIVATE_KEY]):
        raise APIError("ConnectWise API configuration incomplete. Check environment variables.")
    
    # Use the configurable prefix
    username = f"{AUTH_PREFIX}{PUBLIC_KEY}"
    password = PRIVATE_KEY
    
    credentials = f"{username}:{password}"
    encoded_credentials = base64.b64encode(credentials.encode()).decode()
    
    # Return the headers with the successful format
    headers = {
        'Authorization': f'Basic {encoded_credentials}',
        'clientId': COMPANY_ID,
        'Content-Type': 'application/json'
    }
    
    return headers

async def make_api_request(
    method: str,
    endpoint: str,
    params: Optional[Dict[str, Any]] = None,
    data: Optional[Dict[str, Any]] = None,
    headers: Optional[Dict[str, str]] = None
) -> Dict[str, Any]:
    """
    Make a request to the ConnectWise Manage API
    """
    if not API_URL:
        if not setup_config():
            raise APIError("ConnectWise API URL not configured. Check environment variables.")
        
    url = f"{API_URL}{endpoint}"
    if not headers:
        headers = get_auth_header()
    
    logger.info(f"Making {method} request to: {url}")
    if params:
        logger.info(f"Params: {json.dumps(params)}")
    if data:
        logger.info(f"Data: {json.dumps(data)}")
    
    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            if method.upper() == "GET":
                response = await client.get(url, headers=headers, params=params)
            elif method.upper() == "POST":
                response = await client.post(url, headers=headers, json=data)
            elif method.upper() == "PUT":
                response = await client.put(url, headers=headers, json=data)
            elif method.upper() == "PATCH":
                response = await client.patch(url, headers=headers, json=data)
            elif method.upper() == "DELETE":
                response = await client.delete(url, headers=headers)
            else:
                raise APIError(f"Unsupported HTTP method: {method}")
            
            logger.info(f"Response status: {response.status_code}")
            
            response.raise_for_status()
            return response.json() if response.content else {}
            
        except httpx.HTTPStatusError as e:
            error_message = f"HTTP error {e.response.status_code}: {e.response.text}"
            logger.error(error_message)
            raise APIError(error_message, status_code=e.response.status_code, response=e.response)
        except httpx.TimeoutException:
            logger.error("Request timed out. ConnectWise API may be slow to respond.")
            raise APIError("Request timed out. ConnectWise API may be slow to respond.")
        except httpx.RequestError as e:
            logger.error(f"API request error: {str(e)}")
            raise APIError(f"API request failed: {str(e)}")
        except Exception as e:
            logger.error(f"Unknown error: {str(e)}")
            raise APIError(f"Unknown error: {str(e)}")

# Fast Memory Helper Functions

def check_fast_memory(path: str, method: str) -> Optional[Dict[str, Any]]:
    """
    Check if a query exists in Fast Memory.
    
    Args:
        path: API endpoint path
        method: HTTP method
        
    Returns:
        The query if found, None otherwise
    """
    global fast_memory_db, current_query_from_fast_memory
    
    if not fast_memory_db:
        if not initialize_fast_memory():
            logger.error("Failed to initialize Fast Memory database.")
            return None
    
    query = fast_memory_db.find_query(path, method)
    if query:
        # Mark that this query came from Fast Memory
        current_query_from_fast_memory = True
        # Increment usage count
        fast_memory_db.increment_usage(query['id'])
        logger.info(f"Found query in Fast Memory: {path} {method}")
        return query
    
    current_query_from_fast_memory = False
    return None

def format_endpoint_for_saving(method: str, path: str, params: Optional[Dict[str, Any]] = None, data: Optional[Dict[str, Any]] = None) -> str:
    """
    Format endpoint details in a way that can be easily referenced and saved
    
    Args:
        method: HTTP method
        path: API endpoint path
        params: Query parameters
        data: Request body data
    
    Returns:
        Formatted string representation of the endpoint call
    """
    formatted = f"Endpoint: {method.upper()} {path}\n"
    
    if params:
        formatted += "\nQuery Parameters:\n"
        formatted += json.dumps(params, indent=2)
    
    if data:
        formatted += "\nRequest Body:\n"
        formatted += json.dumps(data, indent=2)
        
    formatted += "\n\nTo save this endpoint to Fast Memory:"
    formatted += "\n```"
    formatted += f"\nsave_to_fast_memory("
    formatted += f"\n    path=\"{path}\","
    formatted += f"\n    method=\"{method}\","
    formatted += f"\n    description=\"YOUR DESCRIPTION HERE\","
    
    if params:
        formatted += f"\n    params={json.dumps(params)}"
    else:
        formatted += "\n    params=None"
        
    if data:
        formatted += f",\n    data={json.dumps(data)}"
    
    formatted += "\n)"
    formatted += "\n```"
    
    return formatted

# MCP Tool Implementations

@mcp.tool()
async def search_api_endpoints(query: str, max_results: int = 10) -> str:
    """
    Search for available API endpoints based on a query.
    
    Args:
        query: Search string to find matching endpoints
        max_results: Maximum number of results to return
    """
    if not api_db:
        if not initialize_database():
            return "Error: Failed to initialize API database."
    
    try:
        results = api_db.search_endpoints(query)
        
        if not results:
            return "No API endpoints found matching your query."
        
        formatted_results = []
        for i, endpoint in enumerate(results[:max_results], 1):
            method = endpoint.get('method', '').upper()
            path = endpoint.get('path', '')
            description = endpoint.get('description', 'No description available')
            
            formatted_results.append(f"{i}. {method} {path}\n   {description}")
        
        response = "Found the following API endpoints:\n\n"
        response += "\n\n".join(formatted_results)
        
        if len(results) > max_results:
            response += f"\n\nShowing {max_results} of {len(results)} results. Refine your search for more specific results."
        
        return response
    
    except Exception as e:
        logger.error(f"Error searching API endpoints: {str(e)}")
        return f"Error searching API endpoints: {str(e)}"

@mcp.tool()
async def get_api_endpoint_details(path: str, method: str = "GET") -> str:
    """
    Get detailed information about a specific API endpoint.
    
    Args:
        path: API path (e.g., /service/tickets)
        method: HTTP method (GET, POST, PUT, PATCH, DELETE)
    """
    if not api_db:
        if not initialize_database():
            return "Error: Failed to initialize API database."
    
    try:
        endpoint = api_db.find_endpoint_by_path_method(path, method)
        
        if not endpoint:
            return f"No API endpoint found for {method} {path}."
        
        formatted_details = api_db.format_endpoint_for_display(endpoint)
        return formatted_details
    except Exception as e:
        logger.error(f"Error getting API endpoint details: {str(e)}")
        return f"Error getting API endpoint details: {str(e)}"

@mcp.tool()
async def execute_api_call(
    path: str, 
    method: str = "GET", 
    params: Optional[Dict[str, Any]] = None, 
    data: Optional[Dict[str, Any]] = None
) -> str:
    """
    Execute an API call to the ConnectWise API.
    
    Args:
        path: API endpoint path (e.g., /service/tickets)
        method: HTTP method (GET, POST, PUT, PATCH, DELETE)
        params: Query parameters for the request
        data: Request body data (for POST, PUT, PATCH)
    """
    global current_query_from_fast_memory
    
    if not api_db:
        if not initialize_database():
            return "Error: Failed to initialize API database."
    
    # Check Fast Memory first
    fast_memory_entry = check_fast_memory(path, method)
    if fast_memory_entry:
        # If parameters are not provided, use the ones from Fast Memory
        if params is None and 'params' in fast_memory_entry and fast_memory_entry['params']:
            params = fast_memory_entry['params']
            logger.info(f"Using parameters from Fast Memory: {json.dumps(params)}")
        
        # If data is not provided, use the one from Fast Memory
        if data is None and 'data' in fast_memory_entry and fast_memory_entry['data']:
            data = fast_memory_entry['data']
            logger.info(f"Using data from Fast Memory: {json.dumps(data)}")
    
    try:
        # Verify the endpoint exists in our database
        endpoint = api_db.find_endpoint_by_path_method(path, method)
        if not endpoint:
            return f"Warning: No documented API endpoint found for {method} {path}. Proceeding with caution."
        
        # Execute the API call
        result = await make_api_request(method, path, params, data)
        
        # Format the response
        response = ""
        if isinstance(result, list):
            if len(result) > 10:
                summary = f"Retrieved {len(result)} items. Showing first 10:"
                formatted_data = json.dumps(result[:10], indent=2)
                response = f"{summary}\n\n{formatted_data}\n\n(Response truncated. Full response contained {len(result)} items.)"
            else:
                response = json.dumps(result, indent=2)
        else:
            response = json.dumps(result, indent=2)
        
        # If the query was successful and not from Fast Memory, ask if the user wants to save it
        if not current_query_from_fast_memory:
            # Add a section that shows the endpoint details for easy reference and saving
            endpoint_details = format_endpoint_for_saving(method, path, params, data)
            response += f"\n\n=== SUCCESSFUL API CALL ===\n{endpoint_details}\n\nWould you like to save this query to Fast Memory for quicker access in the future? You can use the save_to_fast_memory function above or reply with a description."
        else:
            # Reset the flag
            current_query_from_fast_memory = False
            
            # Add a note that this query came from Fast Memory
            response = f"[Using query from Fast Memory: {fast_memory_entry['description']}]\n\n" + response
            
        return response
    
    except APIError as e:
        # Reset the flag
        current_query_from_fast_memory = False
        return f"API Error ({e.status_code if e.status_code else 'Unknown'}): {e.message}"
    except Exception as e:
        # Reset the flag
        current_query_from_fast_memory = False
        logger.error(f"Error executing API call: {str(e)}")
        return f"Error executing API call: {str(e)}"

@mcp.tool()
async def natural_language_api_search(query: str, max_results: int = 5) -> str:
    """
    Search for API endpoints using natural language.
    
    Args:
        query: Natural language description of what you're looking for
        max_results: Maximum number of results to return
    """
    if not api_db:
        if not initialize_database():
            return "Error: Failed to initialize API database."
    
    try:
        results = api_db.search_by_natural_language(query, max_results)
        
        if not results:
            return "No API endpoints found matching your query."
        
        formatted_results = []
        for i, endpoint in enumerate(results, 1):
            method = endpoint.get('method', '').upper()
            path = endpoint.get('path', '')
            description = endpoint.get('description', 'No description available')
            category = endpoint.get('category', 'Unknown')
            
            formatted_results.append(
                f"{i}. {method} {path}\n"
                f"   Category: {category}\n"
                f"   Description: {description}"
            )
        
        response = "Based on your query, here are the most relevant API endpoints:\n\n"
        response += "\n\n".join(formatted_results)
        
        # Add suggestion for getting more details
        response += "\n\nTo get more details about a specific endpoint, use get_api_endpoint_details with the path and method."
        
        return response
    
    except Exception as e:
        logger.error(f"Error searching API endpoints: {str(e)}")
        return f"Error searching API endpoints: {str(e)}"

@mcp.tool()
async def list_api_categories() -> str:
    """
    List all available API categories.
    """
    if not api_db:
        if not initialize_database():
            return "Error: Failed to initialize API database."
    
    try:
        categories = api_db.get_categories()
        
        if not categories:
            return "No API categories found."
        
        response = "Available API categories:\n\n"
        response += "\n".join([f"- {category}" for category in categories])
        
        return response
    
    except Exception as e:
        logger.error(f"Error listing API categories: {str(e)}")
        return f"Error listing API categories: {str(e)}"

@mcp.tool()
async def get_category_endpoints(category: str, max_results: int = 20) -> str:
    """
    Get all endpoints for a specific API category.
    
    Args:
        category: Category name (use list_api_categories to see available categories)
        max_results: Maximum number of results to return
    """
    if not api_db:
        if not initialize_database():
            return "Error: Failed to initialize API database."
    
    try:
        endpoints = api_db.get_endpoints_by_category(category)
        
        if not endpoints:
            return f"No endpoints found for category: {category}"
        
        formatted_results = []
        for i, endpoint in enumerate(endpoints[:max_results], 1):
            method = endpoint.get('method', '').upper()
            path = endpoint.get('path', '')
            summary = endpoint.get('summary', 'No summary available')
            
            formatted_results.append(f"{i}. {method} {path}\n   {summary}")
        
        response = f"Endpoints in category '{category}':\n\n"
        response += "\n\n".join(formatted_results)
        
        if len(endpoints) > max_results:
            response += f"\n\nShowing {max_results} of {len(endpoints)} endpoints. Use a higher max_results value to see more."
        
        return response
    
    except Exception as e:
        logger.error(f"Error getting category endpoints: {str(e)}")
        return f"Error getting category endpoints: {str(e)}"

@mcp.tool()
async def send_raw_api_request(
    raw_request: str
) -> str:
    """
    Send a raw API request to the ConnectWise API.
    
    Args:
        raw_request: Raw API request in the format "METHOD /path?params [JSON body]"
                     Example: "GET /service/tickets?conditions=status/name='Open'"
                     Example: "POST /service/tickets { "summary": "Test ticket" }"
    """
    if not setup_config():
        return "Error: Failed to initialize API configuration."
    
    try:
        # Parse the raw request
        parts = raw_request.strip().split(' ', 2)
        
        if len(parts) < 2:
            return "Error: Invalid request format. Use 'METHOD /path [JSON body]'"
        
        method = parts[0].upper()
        path_with_params = parts[1]
        
        # Extract path and params
        if '?' in path_with_params:
            path, query_string = path_with_params.split('?', 1)
            params = {}
            for param in query_string.split('&'):
                if '=' in param:
                    key, value = param.split('=', 1)
                    params[key] = value
                else:
                    params[param] = ''
        else:
            path = path_with_params
            params = {}
        
        # Extract body if present
        data = None
        if len(parts) > 2:
            try:
                data = json.loads(parts[2])
            except json.JSONDecodeError:
                return f"Error: Invalid JSON body: {parts[2]}"
        
        # Use the execute_api_call function to handle the API call
        # This ensures Fast Memory checking and saving is consistent
        return await execute_api_call(path, method, params, data)
    
    except Exception as e:
        logger.error(f"Error executing raw API request: {str(e)}")
        return f"Error executing raw API request: {str(e)}"

@mcp.tool()
async def save_to_fast_memory(
    path: str,
    method: str,
    description: str,
    params: Optional[Dict[str, Any]] = None,
    data: Optional[Dict[str, Any]] = None
) -> str:
    """
    Save an API query to Fast Memory.
    
    Args:
        path: API endpoint path
        method: HTTP method
        description: User-friendly description of the query
        params: Query parameters
        data: Request body data
    """
    if not fast_memory_db:
        if not initialize_fast_memory():
            return "Error: Failed to initialize Fast Memory database."
    
    try:
        query_id = fast_memory_db.save_query(description, path, method, params, data)
        return f"Successfully saved query to Fast Memory with ID {query_id}."
    except Exception as e:
        logger.error(f"Error saving query to Fast Memory: {str(e)}")
        return f"Error saving query to Fast Memory: {str(e)}"

@mcp.tool()
async def list_fast_memory(search_term: Optional[str] = None) -> str:
    """
    List queries saved in Fast Memory.
    
    Args:
        search_term: Optional search term to filter queries
    """
    if not fast_memory_db:
        if not initialize_fast_memory():
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
        
        # Format the queries
        formatted_queries = []
        for i, query in enumerate(queries, 1):
            # Format the parameters and data
            params_str = json.dumps(query.get('params', {}), indent=2) if query.get('params') else "None"
            data_str = json.dumps(query.get('data', {}), indent=2) if query.get('data') else "None"
            
            # Truncate long parameters and data
            if len(params_str) > 100:
                params_str = params_str[:100] + "... (truncated)"
            if len(data_str) > 100:
                data_str = data_str[:100] + "... (truncated)"
            
            formatted_queries.append(
                f"{i}. {query['description']}\n"
                f"   ID: {query['id']}\n"
                f"   Path: {query['method'].upper()} {query['path']}\n"
                f"   Usage Count: {query['usage_count']}\n"
                f"   Parameters: {params_str}\n"
                f"   Data: {data_str}"
            )
        
        response = "Queries saved in Fast Memory:\n\n"
        response += "\n\n".join(formatted_queries)
        
        response += "\n\nTo use a query from Fast Memory, use execute_api_call with the same path and method."
        response += "\nTo delete a query, use delete_from_fast_memory with the query ID."
        
        return response
    
    except Exception as e:
        logger.error(f"Error listing Fast Memory queries: {str(e)}")
        return f"Error listing Fast Memory queries: {str(e)}"

@mcp.tool()
async def delete_from_fast_memory(query_id: int) -> str:
    """
    Delete a query from Fast Memory.
    
    Args:
        query_id: ID of the query to delete
    """
    if not fast_memory_db:
        if not initialize_fast_memory():
            return "Error: Failed to initialize Fast Memory database."
    
    try:
        success = fast_memory_db.delete_query(query_id)
        if success:
            return f"Successfully deleted query with ID {query_id} from Fast Memory."
        else:
            return f"No query found with ID {query_id}."
    except Exception as e:
        logger.error(f"Error deleting query from Fast Memory: {str(e)}")
        return f"Error deleting query from Fast Memory: {str(e)}"

@mcp.tool()
async def clear_fast_memory() -> str:
    """
    Clear all queries from Fast Memory.
    """
    if not fast_memory_db:
        if not initialize_fast_memory():
            return "Error: Failed to initialize Fast Memory database."
    
    try:
        count = fast_memory_db.clear_all()
        return f"Successfully cleared {count} queries from Fast Memory."
    except Exception as e:
        logger.error(f"Error clearing Fast Memory: {str(e)}")
        return f"Error clearing Fast Memory: {str(e)}"

def main():
    """Main entry point for the server"""
    logger.info("Starting ConnectWise API Gateway MCP Server...")
    setup_config()
    initialize_database()
    initialize_fast_memory()
    mcp.run(transport='stdio')

# Add these functions to your existing MCP server

@mcp.tool()
async def debug_notes_endpoint(ticket_id: int) -> str:
    """
    Debug notes endpoint access with detailed information
    
    Args:
        ticket_id: The ticket ID to debug notes access for
    """
    try:
        # Step 1: Verify ticket exists and get its details
        logger.info(f"Step 1: Checking ticket {ticket_id} details...")
        
        ticket_path = f"/service/tickets/{ticket_id}"
        ticket_result = await make_api_request("GET", ticket_path)
        
        if not ticket_result:
            return f"❌ Ticket {ticket_id} not found or inaccessible"
        
        # Extract key ticket information
        ticket_info = {
            "id": ticket_result.get("id"),
            "summary": ticket_result.get("summary", "No summary"),
            "board": ticket_result.get("board", {}).get("name", "Unknown"),
            "status": ticket_result.get("status", {}).get("name", "Unknown"),
            "company": ticket_result.get("company", {}).get("name", "Unknown"),
            "recordType": ticket_result.get("recordType", "Unknown")
        }
        
        result = f"✅ Ticket {ticket_id} found:\n"
        result += f"  Summary: {ticket_info['summary']}\n"
        result += f"  Board: {ticket_info['board']}\n"
        result += f"  Status: {ticket_info['status']}\n"
        result += f"  Company: {ticket_info['company']}\n"
        result += f"  Type: {ticket_info['recordType']}\n\n"
        
        # Step 2: Check if notes_href is provided in ticket response
        if "_info" in ticket_result and "notes_href" in ticket_result["_info"]:
            notes_href = ticket_result["_info"]["notes_href"]
            result += f"✅ Notes URL provided: {notes_href}\n\n"
        else:
            result += "❌ No notes_href found in ticket response\n\n"
        
        # Step 3: Test different notes endpoint variations
        result += "Step 2: Testing notes endpoint variations...\n"
        
        notes_endpoints = [
            f"/service/tickets/{ticket_id}/notes",
            f"/service/tickets/{ticket_id}/notes/",
            f"/service/serviceTickets/{ticket_id}/notes"
        ]
        
        for endpoint in notes_endpoints:
            try:
                logger.info(f"Testing endpoint: {endpoint}")
                notes_result = await make_api_request("GET", endpoint)
                
                if isinstance(notes_result, list):
                    result += f"✅ {endpoint} - SUCCESS: Found {len(notes_result)} notes\n"
                    
                    if notes_result:
                        # Show details of first note
                        first_note = notes_result[0]
                        result += f"   First note ID: {first_note.get('id', 'No ID')}\n"
                        result += f"   Created: {first_note.get('dateCreated', 'Unknown')}\n"
                        result += f"   Text length: {len(first_note.get('text', ''))}\n"
                    
                    return result + f"\n🎉 SUCCESS! Use endpoint: {endpoint}"
                    
                elif isinstance(notes_result, dict):
                    result += f"✅ {endpoint} - Got response (dict): {list(notes_result.keys())}\n"
                else:
                    result += f"⚠️ {endpoint} - Unexpected response type: {type(notes_result)}\n"
                    
            except APIError as e:
                result += f"❌ {endpoint} - Error {e.status_code}: {e.message}\n"
            except Exception as e:
                result += f"❌ {endpoint} - Exception: {str(e)}\n"
        
        # Step 4: Check if it's a project ticket instead
        if ticket_info.get("recordType") == "ProjectTicket":
            result += "\nStep 3: Detected ProjectTicket, testing project notes endpoint...\n"
            project_notes_endpoint = f"/project/tickets/{ticket_id}/notes"
            
            try:
                project_notes_result = await make_api_request("GET", project_notes_endpoint)
                if isinstance(project_notes_result, list):
                    result += f"✅ {project_notes_endpoint} - SUCCESS: Found {len(project_notes_result)} notes\n"
                    return result + f"\n🎉 SUCCESS! Use project endpoint: {project_notes_endpoint}"
                else:
                    result += f"⚠️ {project_notes_endpoint} - Unexpected response: {type(project_notes_result)}\n"
            except APIError as e:
                result += f"❌ {project_notes_endpoint} - Error {e.status_code}: {e.message}\n"
        
        # Step 5: Check API user permissions by testing other ticket endpoints
        result += "\nStep 4: Testing related endpoint permissions...\n"
        
        related_endpoints = [
            f"/service/tickets/{ticket_id}/tasks",
            f"/service/tickets/{ticket_id}/documents", 
            f"/service/tickets/{ticket_id}/configurations"
        ]
        
        for endpoint in related_endpoints:
            try:
                related_result = await make_api_request("GET", endpoint)
                result += f"✅ {endpoint} - Accessible\n"
            except APIError as e:
                result += f"❌ {endpoint} - Error {e.status_code}: {e.message}\n"
        
        result += "\n❌ CONCLUSION: Notes endpoint not accessible through standard paths"
        result += "\n\nPossible causes:"
        result += "\n1. API user lacks notes permission"
        result += "\n2. Notes are disabled for this board/ticket type"
        result += "\n3. ConnectWise version compatibility issue"
        result += "\n4. Notes endpoint path is different in your version"
        
        return result
        
    except Exception as e:
        return f"❌ Error during notes debugging: {str(e)}"

@mcp.tool()
async def try_notes_with_conditions(ticket_id: int) -> str:
    """
    Try accessing notes with different query conditions and parameters
    
    Args:
        ticket_id: The ticket ID to test
    """
    result = f"Testing notes access for ticket {ticket_id} with various conditions...\n\n"
    
    # Different parameter combinations to try
    test_cases = [
        {"description": "Basic request", "params": None},
        {"description": "With pageSize", "params": {"pageSize": 10}},
        {"description": "With conditions", "params": {"conditions": "id > 0"}},
        {"description": "With fields", "params": {"fields": "id,text,dateCreated"}},
        {"description": "With orderBy", "params": {"orderBy": "dateCreated"}},
        {"description": "Internal only", "params": {"conditions": "internalAnalysisFlag=true"}},
        {"description": "External only", "params": {"conditions": "internalAnalysisFlag=false"}},
    ]
    
    notes_path = f"/service/tickets/{ticket_id}/notes"
    
    for test_case in test_cases:
        try:
            logger.info(f"Testing: {test_case['description']}")
            notes_result = await make_api_request("GET", notes_path, params=test_case["params"])
            
            if isinstance(notes_result, list):
                result += f"✅ {test_case['description']}: Found {len(notes_result)} notes\n"
                if notes_result and test_case['description'] == "Basic request":
                    # Show structure of first note for basic request
                    first_note = notes_result[0]
                    result += f"   Sample note structure: {list(first_note.keys())}\n"
            else:
                result += f"⚠️ {test_case['description']}: Unexpected response type {type(notes_result)}\n"
                
        except APIError as e:
            result += f"❌ {test_case['description']}: Error {e.status_code} - {e.message}\n"
        except Exception as e:
            result += f"❌ {test_case['description']}: Exception - {str(e)}\n"
    
    return result

@mcp.tool()
async def check_api_user_permissions() -> str:
    """
    Check what permissions the current API user has
    """
    result = "Checking API user permissions...\n\n"
    
    # Test various endpoints to understand permission scope
    test_endpoints = [
        {"path": "/system/members", "description": "System members"},
        {"path": "/system/myMember", "description": "Current user info"},
        {"path": "/service/boards", "description": "Service boards"},
        {"path": "/service/sources", "description": "Service sources"},
        {"path": "/service/priorities", "description": "Service priorities"},
        {"path": "/service/statuses", "description": "Service statuses"},
        {"path": "/service/tickets", "description": "Service tickets", "params": {"pageSize": 1}},
    ]
    
    for test in test_endpoints:
        try:
            test_result = await make_api_request("GET", test["path"], params=test.get("params"))
            
            if isinstance(test_result, list):
                result += f"✅ {test['description']}: Access granted ({len(test_result)} items)\n"
            elif isinstance(test_result, dict):
                result += f"✅ {test['description']}: Access granted (object response)\n"
            else:
                result += f"⚠️ {test['description']}: Unusual response type {type(test_result)}\n"
                
        except APIError as e:
            if e.status_code == 403:
                result += f"❌ {test['description']}: Access forbidden\n"
            elif e.status_code == 401:
                result += f"❌ {test['description']}: Authentication failed\n"
            else:
                result += f"❌ {test['description']}: Error {e.status_code}\n"
        except Exception as e:
            result += f"❌ {test['description']}: Exception - {str(e)}\n"
    
    return result

@mcp.tool()
async def test_notes_crud_operations(ticket_id: int) -> str:
    """
    Test Create, Read, Update, Delete operations for notes
    
    Args:
        ticket_id: Ticket ID to test notes operations on
    """
    result = f"Testing CRUD operations for notes on ticket {ticket_id}...\n\n"
    notes_path = f"/service/tickets/{ticket_id}/notes"
    
    # Step 1: Test READ
    result += "Step 1: Testing READ access...\n"
    try:
        read_result = await make_api_request("GET", notes_path)
        if isinstance(read_result, list):
            result += f"✅ READ: Success - Found {len(read_result)} existing notes\n"
            original_count = len(read_result)
        else:
            result += f"⚠️ READ: Unexpected response type - {type(read_result)}\n"
            original_count = 0
    except APIError as e:
        result += f"❌ READ: Failed - {e.status_code}: {e.message}\n"
        return result + "\n❌ Cannot proceed with other tests - READ access required"
    
    # Step 2: Test CREATE
    result += "\nStep 2: Testing CREATE access...\n"
    test_note_data = {
        "text": "API Test Note - Created by debug function",
        "internalAnalysisFlag": True,  # Internal note to avoid customer notification
        "detailDescriptionFlag": False
    }
    
    created_note_id = None
    try:
        create_result = await make_api_request("POST", notes_path, data=test_note_data)
        if isinstance(create_result, dict) and "id" in create_result:
            created_note_id = create_result["id"]
            result += f"✅ CREATE: Success - Created note with ID {created_note_id}\n"
        else:
            result += f"⚠️ CREATE: Unexpected response - {create_result}\n"
    except APIError as e:
        result += f"❌ CREATE: Failed - {e.status_code}: {e.message}\n"
    
    # Step 3: Test UPDATE (if we created a note)
    if created_note_id:
        result += "\nStep 3: Testing UPDATE access...\n"
        update_data = {
            "text": "API Test Note - Updated by debug function",
            "internalAnalysisFlag": True
        }
        
        try:
            update_result = await make_api_request("PATCH", f"{notes_path}/{created_note_id}", data=update_data)
            result += f"✅ UPDATE: Success - Updated note {created_note_id}\n"
        except APIError as e:
            result += f"❌ UPDATE: Failed - {e.status_code}: {e.message}\n"
    
    # Step 4: Test DELETE (if we created a note)
    if created_note_id:
        result += "\nStep 4: Testing DELETE access...\n"
        try:
            delete_result = await make_api_request("DELETE", f"{notes_path}/{created_note_id}")
            result += f"✅ DELETE: Success - Deleted note {created_note_id}\n"
        except APIError as e:
            result += f"❌ DELETE: Failed - {e.status_code}: {e.message}\n"
            result += f"⚠️ Note {created_note_id} may need manual cleanup\n"
    
    # Step 5: Verify final count
    result += "\nStep 5: Verifying final state...\n"
    try:
        final_result = await make_api_request("GET", notes_path)
        if isinstance(final_result, list):
            final_count = len(final_result)
            if final_count == original_count:
                result += f"✅ VERIFICATION: Note count returned to original ({final_count})\n"
            else:
                result += f"⚠️ VERIFICATION: Note count changed from {original_count} to {final_count}\n"
    except APIError as e:
        result += f"❌ VERIFICATION: Failed to check final state - {e.message}\n"
    
    return result

# Add this enhanced error handler to your make_api_request function
def handle_notes_specific_errors(response, endpoint_path):
    """Handle notes-specific error responses"""
    if "/notes" in endpoint_path:
        if response.status_code == 403:
            return "Notes access forbidden. Check if:\n1. API user has notes permissions\n2. Board allows note access\n3. Ticket type supports notes"
        elif response.status_code == 404:
            return "Notes endpoint not found. This ticket may not support notes or the endpoint path is incorrect."
        elif response.status_code == 400:
            return "Bad request for notes. Check your parameters and data format."
    
    return None  # Use default error handling

# Add these enhanced functions to your existing MCP server

@mcp.tool()
async def get_ticket_notes_with_content(ticket_id: int, include_internal: bool = True, include_external: bool = True) -> str:
    """
    Get all notes for a ticket with full text content and metadata
    
    Args:
        ticket_id: The ticket ID to get notes for
        include_internal: Whether to include internal notes
        include_external: Whether to include external/customer notes
    """
    try:
        result = f"📝 Notes for Ticket #{ticket_id}\n"
        result += "=" * 50 + "\n\n"
        
        # First verify ticket exists
        ticket_path = f"/service/tickets/{ticket_id}"
        try:
            ticket_info = await make_api_request("GET", ticket_path)
            result += f"**Ticket:** {ticket_info.get('summary', 'No summary')}\n"
            result += f"**Company:** {ticket_info.get('company', {}).get('name', 'Unknown')}\n"
            result += f"**Status:** {ticket_info.get('status', {}).get('name', 'Unknown')}\n\n"
        except APIError:
            result += f"**Ticket:** {ticket_id} (details not accessible)\n\n"
        
        # Try different notes endpoints
        notes_endpoints = [
            f"/service/tickets/{ticket_id}/notes",
            f"/project/tickets/{ticket_id}/notes"
        ]
        
        notes_found = False
        all_notes = []
        
        for endpoint in notes_endpoints:
            try:
                notes_result = await make_api_request("GET", endpoint)
                if isinstance(notes_result, list) and notes_result:
                    all_notes = notes_result
                    notes_found = True
                    break
            except APIError:
                continue
        
        if not notes_found:
            result += "❌ **No notes found or notes not accessible**\n\n"
            result += "**Possible reasons:**\n"
            result += "• API user lacks notes permissions\n"
            result += "• No notes exist for this ticket\n"
            result += "• Notes endpoint not available for this ticket type\n"
            return result
        
        # Filter notes based on parameters
        filtered_notes = []
        for note in all_notes:
            internal_flag = note.get('internalFlag', note.get('internalAnalysisFlag', False))
            external_flag = note.get('externalFlag', not internal_flag)
            
            if (include_internal and internal_flag) or (include_external and external_flag):
                filtered_notes.append(note)
        
        if not filtered_notes:
            result += "❌ **No notes found matching the specified criteria**\n"
            return result
        
        # Sort notes by creation date
        filtered_notes.sort(key=lambda x: x.get('dateCreated', ''), reverse=False)
        
        result += f"**Found {len(filtered_notes)} notes** (Total: {len(all_notes)})\n\n"
        
        # Display each note
        for i, note in enumerate(filtered_notes, 1):
            result += f"### Note #{i}\n"
            result += f"**ID:** {note.get('id', 'Unknown')}\n"
            result += f"**Created:** {note.get('dateCreated', 'Unknown')}\n"
            result += f"**Created By:** {note.get('createdBy', 'Unknown')}\n"
            
            # Note type/visibility
            internal_flag = note.get('internalFlag', note.get('internalAnalysisFlag', False))
            external_flag = note.get('externalFlag', not internal_flag)
            visibility = "Internal" if internal_flag else "External/Customer"
            result += f"**Visibility:** {visibility}\n"
            
            # Note flags
            flags = []
            if note.get('resolutionFlag'):
                flags.append("Resolution")
            if note.get('issueFlag'):
                flags.append("Issue")
            if note.get('detailDescriptionFlag'):
                flags.append("Detail Description")
            
            if flags:
                result += f"**Flags:** {', '.join(flags)}\n"
            
            # Contact information
            if note.get('contact'):
                contact = note['contact']
                contact_name = contact.get('name', 'Unknown')
                result += f"**Contact:** {contact_name}\n"
            
            # Note text content
            note_text = note.get('text', '')
            if note_text:
                result += f"**Text:**\n```\n{note_text}\n```\n"
            else:
                result += "**Text:** (No text content)\n"
            
            result += "\n" + "-" * 40 + "\n\n"
        
        return result
        
    except Exception as e:
        return f"❌ Error retrieving notes: {str(e)}"

@mcp.tool()
async def get_ticket_attachments_with_details(ticket_id: int, download_info: bool = True) -> str:
    """
    Get all attachments/documents for a ticket with detailed metadata
    
    Args:
        ticket_id: The ticket ID to get attachments for
        download_info: Whether to include download information
    """
    try:
        result = f"📎 Attachments for Ticket #{ticket_id}\n"
        result += "=" * 50 + "\n\n"
        
        # Get documents for this ticket
        documents_result = await make_api_request(
            "GET", 
            "/system/documents",
            params={"recordType": "Ticket", "recordId": str(ticket_id)}
        )
        
        if not documents_result:
            result += "❌ **No attachments found for this ticket**\n"
            return result
        
        result += f"**Found {len(documents_result)} attachment(s)**\n\n"
        
        total_size = 0
        
        for i, doc in enumerate(documents_result, 1):
            result += f"### Attachment #{i}\n"
            result += f"**ID:** {doc.get('id', 'Unknown')}\n"
            result += f"**Title:** {doc.get('title', 'No title')}\n"
            result += f"**Filename:** {doc.get('fileName', 'Unknown')}\n"
            
            # File size
            size = doc.get('size', 0)
            total_size += size
            if size > 0:
                if size < 1024:
                    size_str = f"{size} bytes"
                elif size < 1024 * 1024:
                    size_str = f"{size / 1024:.1f} KB"
                else:
                    size_str = f"{size / (1024 * 1024):.1f} MB"
                result += f"**Size:** {size_str}\n"
            
            # Document type
            doc_type = doc.get('documentType', {})
            if doc_type:
                type_name = doc_type.get('name', 'Unknown')
                result += f"**Type:** {type_name}\n"
            
            # File properties
            result += f"**Owner:** {doc.get('owner', 'Unknown')}\n"
            result += f"**Created:** {doc.get('createdOnDate', 'Unknown')}\n"
            result += f"**Updated:** {doc.get('_info', {}).get('lastUpdated', 'Unknown')}\n"
            
            # Flags
            flags = []
            if doc.get('publicFlag'):
                flags.append("Public")
            if doc.get('readOnlyFlag'):
                flags.append("Read-Only")
            if doc.get('linkFlag'):
                flags.append("Link")
            if doc.get('imageFlag'):
                flags.append("Image")
            if doc.get('htmlTemplateFlag'):
                flags.append("HTML Template")
            
            if flags:
                result += f"**Properties:** {', '.join(flags)}\n"
            
            # Download information
            if download_info:
                doc_id = doc.get('id')
                if doc_id:
                    result += f"**Download URL:** `/system/documents/{doc_id}/download`\n"
                    
                    # Check if thumbnail available
                    if doc.get('imageFlag'):
                        result += f"**Thumbnail URL:** `/system/documents/{doc_id}/thumbnail`\n"
            
            # GUID information (for advanced users)
            if doc.get('guid'):
                result += f"**GUID:** {doc.get('guid')}\n"
            
            result += "\n" + "-" * 40 + "\n\n"
        
        # Summary
        if total_size > 0:
            if total_size < 1024 * 1024:
                total_size_str = f"{total_size / 1024:.1f} KB"
            else:
                total_size_str = f"{total_size / (1024 * 1024):.1f} MB"
            result += f"**Total Size:** {total_size_str}\n\n"
        
        # Usage instructions
        if download_info:
            result += "### 📥 Download Instructions\n"
            result += "To download attachments, use:\n"
            result += "```\nexecute_api_call(\n"
            result += "    path='/system/documents/{document_id}/download',\n"
            result += "    method='GET'\n"
            result += ")\n```\n\n"
        
        return result
        
    except APIError as e:
        return f"❌ API Error getting attachments: {e.message}"
    except Exception as e:
        return f"❌ Error retrieving attachments: {str(e)}"

@mcp.tool()
async def get_complete_ticket_content(ticket_id: int) -> str:
    """
    Get complete ticket content including details, notes, attachments, and related data
    
    Args:
        ticket_id: The ticket ID to get complete content for
    """
    try:
        result = f"🎫 Complete Content for Ticket #{ticket_id}\n"
        result += "=" * 60 + "\n\n"
        
        # Step 1: Get ticket details
        result += "## 📋 Ticket Details\n"
        try:
            ticket_info = await make_api_request("GET", f"/service/tickets/{ticket_id}")
            
            result += f"**Summary:** {ticket_info.get('summary', 'No summary')}\n"
            result += f"**Company:** {ticket_info.get('company', {}).get('name', 'Unknown')}\n"
            result += f"**Board:** {ticket_info.get('board', {}).get('name', 'Unknown')}\n"
            result += f"**Status:** {ticket_info.get('status', {}).get('name', 'Unknown')}\n"
            result += f"**Priority:** {ticket_info.get('priority', {}).get('name', 'Unknown')}\n"
            result += f"**Type:** {ticket_info.get('type', {}).get('name', 'Unknown')}\n"
            
            if ticket_info.get('contact'):
                contact = ticket_info['contact']
                result += f"**Contact:** {contact.get('name', 'Unknown')}"
                if contact.get('contactEmailAddress') or ticket_info.get('contactEmailAddress'):
                    email = contact.get('contactEmailAddress') or ticket_info.get('contactEmailAddress')
                    result += f" ({email})"
                result += "\n"
            
            result += f"**Created:** {ticket_info.get('_info', {}).get('dateEntered', 'Unknown')}\n"
            result += f"**Updated:** {ticket_info.get('_info', {}).get('lastUpdated', 'Unknown')}\n"
            result += f"**Entered By:** {ticket_info.get('_info', {}).get('enteredBy', 'Unknown')}\n"
            
            if ticket_info.get('owner'):
                owner = ticket_info['owner']
                result += f"**Owner:** {owner.get('name', 'Unknown')}\n"
            
            if ticket_info.get('resources'):
                result += f"**Resources:** {ticket_info.get('resources')}\n"
            
            result += "\n"
            
        except APIError as e:
            result += f"❌ Could not retrieve ticket details: {e.message}\n\n"
        
        # Step 2: Get notes
        result += "## 📝 Notes\n"
        try:
            notes_content = await get_ticket_notes_with_content(ticket_id)
            # Extract just the notes part (remove header)
            notes_lines = notes_content.split('\n')
            notes_start = next((i for i, line in enumerate(notes_lines) if 'Found' in line and 'notes' in line), 0)
            if notes_start > 0:
                result += '\n'.join(notes_lines[notes_start:])
            else:
                result += notes_content
        except Exception as e:
            result += f"❌ Error retrieving notes: {str(e)}\n"
        
        result += "\n"
        
        # Step 3: Get attachments
        result += "## 📎 Attachments\n"
        try:
            attachments_content = await get_ticket_attachments_with_details(ticket_id)
            # Extract just the attachments part (remove header)
            attachments_lines = attachments_content.split('\n')
            attachments_start = next((i for i, line in enumerate(attachments_lines) if 'Found' in line and 'attachment' in line), 0)
            if attachments_start > 0:
                result += '\n'.join(attachments_lines[attachments_start:])
            else:
                result += attachments_content
        except Exception as e:
            result += f"❌ Error retrieving attachments: {str(e)}\n"
        
        result += "\n"
        
        # Step 4: Get time entries if available
        result += "## ⏰ Time Entries\n"
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
                result += f"**Found {len(time_entries)} time entries**\n\n"
                for i, entry in enumerate(time_entries[:5], 1):  # Show max 5
                    result += f"### Time Entry #{i}\n"
                    result += f"**Hours:** {entry.get('actualHours', 0)}\n"
                    result += f"**Date:** {entry.get('timeStart', 'Unknown')}\n"
                    result += f"**Member:** {entry.get('member', {}).get('name', 'Unknown')}\n"
                    result += f"**Notes:** {entry.get('notes', 'No notes')}\n"
                    result += f"**Work Type:** {entry.get('workType', {}).get('name', 'Unknown')}\n\n"
                
                if len(time_entries) > 5:
                    result += f"... and {len(time_entries) - 5} more time entries\n"
            else:
                result += "No time entries found\n"
                
        except Exception as e:
            result += f"❌ Error retrieving time entries: {str(e)}\n"
        
        result += "\n"
        
        # Step 5: Get tasks if available
        result += "## ✅ Tasks\n"
        try:
            tasks = await make_api_request("GET", f"/service/tickets/{ticket_id}/tasks")
            
            if tasks:
                result += f"**Found {len(tasks)} tasks**\n\n"
                for i, task in enumerate(tasks, 1):
                    result += f"### Task #{i}\n"
                    result += f"**Summary:** {task.get('summary', 'No summary')}\n"
                    result += f"**Priority:** {task.get('priority', {}).get('name', 'Unknown')}\n"
                    result += f"**Status:** {task.get('status', {}).get('name', 'Unknown')}\n"
                    result += f"**Due Date:** {task.get('dueDate', 'No due date')}\n"
                    if task.get('notes'):
                        result += f"**Notes:** {task.get('notes')}\n"
                    result += "\n"
            else:
                result += "No tasks found\n"
                
        except Exception as e:
            result += f"❌ Error retrieving tasks: {str(e)}\n"
        
        # Summary
        result += "\n## 📊 Content Summary\n"
        result += f"This report contains all available content for ticket #{ticket_id}.\n"
        result += "Use the individual functions (get_ticket_notes_with_content, get_ticket_attachments_with_details) for more detailed access.\n"
        
        return result
        
    except Exception as e:
        return f"❌ Error generating complete ticket content: {str(e)}"

@mcp.tool()
async def download_ticket_attachment(ticket_id: int, document_id: int, save_path: Optional[str] = None) -> str:
    """
    Download a specific attachment from a ticket
    
    Args:
        ticket_id: The ticket ID
        document_id: The document/attachment ID to download
        save_path: Optional local path to save the file
    """
    try:
        # First get document metadata
        doc_info = await make_api_request("GET", f"/system/documents/{document_id}")
        
        if not doc_info:
            return f"❌ Document {document_id} not found"
        
        filename = doc_info.get('fileName', f'document_{document_id}')
        size = doc_info.get('size', 0)
        
        result = f"📥 Downloading: {filename}\n"
        result += f"Document ID: {document_id}\n"
        result += f"Size: {size} bytes\n\n"
        
        # Download the file
        download_response = await make_api_request("GET", f"/system/documents/{document_id}/download")
        
        # Note: The actual file content would be in the response
        # In a real implementation, you'd handle the binary data appropriately
        result += "✅ Download completed successfully\n"
        
        if save_path:
            result += f"File would be saved to: {save_path}\n"
        else:
            result += f"File content available (binary data, {len(str(download_response))} characters)\n"
        
        result += "\n**Note:** This function demonstrates the download process. "
        result += "In a real implementation, you would handle the binary file data appropriately.\n"
        
        return result
        
    except APIError as e:
        return f"❌ Download failed: {e.message}"
    except Exception as e:
        return f"❌ Error downloading attachment: {str(e)}"

@mcp.tool()
async def create_ticket_note(
    ticket_id: int,
    text: str,
    internal_only: bool = True,
    resolution_note: bool = False,
    issue_note: bool = False
) -> str:
    """
    Create a new note on a ticket
    
    Args:
        ticket_id: The ticket ID to add the note to
        text: The note text content
        internal_only: Whether the note should be internal only (not visible to customer)
        resolution_note: Whether this is a resolution note
        issue_note: Whether this is an issue description note
    """
    try:
        # Prepare note data
        note_data = {
            "text": text,
            "internalAnalysisFlag": internal_only,
            "externalFlag": not internal_only,
            "resolutionFlag": resolution_note,
            "issueFlag": issue_note,
            "detailDescriptionFlag": False
        }
        
        # Try service ticket notes first
        try:
            result = await make_api_request("POST", f"/service/tickets/{ticket_id}/notes", data=note_data)
        except APIError:
            # Try project ticket notes as fallback
            result = await make_api_request("POST", f"/project/tickets/{ticket_id}/notes", data=note_data)
        
        if result and "id" in result:
            note_id = result["id"]
            visibility = "Internal" if internal_only else "External/Customer"
            
            response = f"✅ Successfully created note on ticket #{ticket_id}\n"
            response += f"Note ID: {note_id}\n"
            response += f"Visibility: {visibility}\n"
            response += f"Type: "
            
            types = []
            if resolution_note:
                types.append("Resolution")
            if issue_note:
                types.append("Issue")
            if not types:
                types.append("General")
            
            response += ", ".join(types) + "\n"
            response += f"Text Length: {len(text)} characters\n"
            
            return response
        else:
            return f"⚠️ Note creation returned unexpected response: {result}"
        
    except APIError as e:
        return f"❌ Failed to create note: {e.message}"
    except Exception as e:
        return f"❌ Error creating note: {str(e)}"

@mcp.tool()
async def search_tickets_by_content(
    search_text: str,
    search_notes: bool = True,
    search_summary: bool = True,
    max_results: int = 10
) -> str:
    """
    Search for tickets by content in summary or notes
    
    Args:
        search_text: Text to search for
        search_notes: Whether to search in notes
        search_summary: Whether to search in ticket summary
        max_results: Maximum number of results to return
    """
    try:
        result = f"🔍 Searching for: '{search_text}'\n"
        result += "=" * 50 + "\n\n"
        
        found_tickets = []
        
        # Search in ticket summaries
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
                
                for ticket in tickets:
                    found_tickets.append({
                        "ticket": ticket,
                        "match_type": "Summary",
                        "match_text": ticket.get("summary", "")
                    })
                    
            except APIError as e:
                result += f"⚠️ Could not search ticket summaries: {e.message}\n"
        
        # Note: Searching notes content requires getting all tickets and checking their notes
        # This is a more complex operation that might timeout
        if search_notes and len(found_tickets) < max_results:
            result += "Note: Direct note content search requires individual ticket note retrieval.\n"
            result += "Consider using ticket summary search or specific ticket IDs for note content.\n\n"
        
        if not found_tickets:
            result += f"❌ No tickets found containing '{search_text}'\n"
            return result
        
        result += f"**Found {len(found_tickets)} tickets**\n\n"
        
        for i, item in enumerate(found_tickets[:max_results], 1):
            ticket = item["ticket"]
            result += f"### {i}. Ticket #{ticket.get('id')}\n"
            result += f"**Summary:** {ticket.get('summary', 'No summary')}\n"
            result += f"**Company:** {ticket.get('company', {}).get('name', 'Unknown')}\n"
            result += f"**Status:** {ticket.get('status', {}).get('name', 'Unknown')}\n"
            result += f"**Match Type:** {item['match_type']}\n"
            result += f"**Created:** {ticket.get('_info', {}).get('dateEntered', 'Unknown')}\n"
            result += "\n"
        
        return result
        
    except Exception as e:
        return f"❌ Error searching tickets: {str(e)}"
    

# Add these functions to your existing MCP server after the existing @mcp.tool() functions

@mcp.tool()
async def get_agreement_additions(agreement_id: int, include_details: bool = True) -> str:
    """
    Get all additions for a specific agreement with quantities and costs
    
    Args:
        agreement_id: The agreement ID to get additions for
        include_details: Whether to include detailed cost/quantity information
    """
    try:
        result = f"📋 Agreement Additions for Agreement #{agreement_id}\n"
        result += "=" * 60 + "\n\n"
        
        # First get agreement details
        try:
            agreement_info = await make_api_request("GET", f"/finance/agreements/{agreement_id}")
            result += f"**Agreement:** {agreement_info.get('name', 'Unknown')}\n"
            result += f"**Type:** {agreement_info.get('type', {}).get('name', 'Unknown')}\n"
            result += f"**Company:** {agreement_info.get('company', {}).get('name', 'Unknown')}\n"
            result += f"**Status:** {agreement_info.get('agreementStatus', 'Unknown')}\n\n"
        except APIError as e:
            result += f"**Agreement:** {agreement_id} (details not accessible: {e.message})\n\n"
        
        # Get additions - bypass warning system by making direct API call
        additions_path = f"/finance/agreements/{agreement_id}/additions"
        
        try:
            # Make direct API call without endpoint verification
            additions_result = await make_api_request("GET", additions_path)
            
            if not additions_result:
                result += "❌ **No additions found for this agreement**\n\n"
                result += "**This could mean:**\n"
                result += "• No additions have been configured\n"
                result += "• Agreement uses child agreements instead of additions\n"
                result += "• API user lacks permissions for additions\n"
                return result
            
            if not isinstance(additions_result, list):
                result += f"⚠️ **Unexpected response type:** {type(additions_result)}\n"
                result += f"Response: {additions_result}\n"
                return result
            
            result += f"**Found {len(additions_result)} addition(s)**\n\n"
            
            total_amount = 0
            
            # Display each addition
            for i, addition in enumerate(additions_result, 1):
                result += f"### Addition #{i}\n"
                result += f"**ID:** {addition.get('id', 'Unknown')}\n"
                
                # Product information
                if addition.get('product'):
                    product = addition['product']
                    result += f"**Product:** {product.get('name', 'Unknown')}\n"
                    result += f"**Product ID:** {product.get('id', 'Unknown')}\n"
                
                # Quantity and pricing
                quantity = addition.get('quantity', 0)
                unit_price = addition.get('unitPrice', 0)
                extended_price = addition.get('extendedPrice', 0)
                
                result += f"**Quantity:** {quantity}\n"
                result += f"**Unit Price:** ${unit_price:,.2f}\n"
                result += f"**Extended Price:** ${extended_price:,.2f}\n"
                
                total_amount += extended_price
                
                # Dates
                if addition.get('effectiveDate'):
                    result += f"**Effective Date:** {addition.get('effectiveDate')}\n"
                if addition.get('cancelledDate'):
                    result += f"**Cancelled Date:** {addition.get('cancelledDate')}\n"
                
                # Status and billing
                if addition.get('billableOption'):
                    result += f"**Billable Option:** {addition.get('billableOption')}\n"
                
                # Agreement reference
                if addition.get('agreement'):
                    agreement_ref = addition['agreement']
                    result += f"**Agreement:** {agreement_ref.get('name', 'Unknown')}\n"
                
                # Cost information (if available)
                if include_details:
                    cost = addition.get('cost', 0)
                    if cost > 0:
                        result += f"**Cost:** ${cost:,.2f}\n"
                        margin = extended_price - (cost * quantity)
                        result += f"**Margin:** ${margin:,.2f}\n"
                
                # Description
                if addition.get('description'):
                    result += f"**Description:** {addition.get('description')}\n"
                
                # Custom fields
                if addition.get('customFields'):
                    custom_fields = addition['customFields']
                    if custom_fields:
                        result += f"**Custom Fields:** {len(custom_fields)} field(s)\n"
                
                result += "\n" + "-" * 50 + "\n\n"
            
            # Summary
            result += f"## 💰 Summary\n"
            result += f"**Total Additions:** {len(additions_result)}\n"
            result += f"**Total Amount:** ${total_amount:,.2f}\n"
            
            return result
            
        except APIError as e:
            # If direct API call fails, provide detailed error information
            error_msg = f"❌ **API Error accessing additions:** {e.message}\n\n"
            
            if e.status_code == 404:
                error_msg += "**Possible causes:**\n"
                error_msg += "• Additions endpoint not available for this agreement type\n"
                error_msg += "• Agreement ID doesn't exist\n"
                error_msg += "• ConnectWise version doesn't support this endpoint\n"
            elif e.status_code == 403:
                error_msg += "**Possible causes:**\n"
                error_msg += "• API user lacks permissions for agreement additions\n"
                error_msg += "• Agreement additions are restricted\n"
            elif e.status_code == 500:
                error_msg += "**Possible causes:**\n"
                error_msg += "• Server error in ConnectWise\n"
                error_msg += "• Database issue with additions\n"
            
            error_msg += f"\n**HTTP Status Code:** {e.status_code}\n"
            
            return error_msg
            
    except Exception as e:
        return f"❌ Error retrieving agreement additions: {str(e)}"

@mcp.tool()
async def get_agreement_additions_summary(agreement_id: int) -> str:
    """
    Get a summary of agreement additions with totals and counts
    
    Args:
        agreement_id: The agreement ID to get additions summary for
    """
    try:
        # Get additions count first
        try:
            count_result = await make_api_request("GET", f"/finance/agreements/{agreement_id}/additions/count")
            addition_count = count_result.get('count', 0) if isinstance(count_result, dict) else 0
        except APIError:
            addition_count = 0
        
        result = f"📊 Agreement Additions Summary - Agreement #{agreement_id}\n"
        result += "=" * 60 + "\n\n"
        
        if addition_count == 0:
            result += "**No additions found**\n\n"
            result += "This agreement either:\n"
            result += "• Has no additions configured\n"
            result += "• Uses child agreements instead of additions\n"
            result += "• Has additions that are not accessible via API\n"
            return result
        
        result += f"**Total Additions:** {addition_count}\n\n"
        
        # Get the actual additions for detailed summary
        additions_content = await get_agreement_additions(agreement_id, include_details=True)
        
        # Extract just the summary portion
        if "💰 Summary" in additions_content:
            summary_start = additions_content.find("💰 Summary")
            result += additions_content[summary_start:]
        else:
            result += "Could not retrieve detailed addition information"
        
        return result
        
    except Exception as e:
        return f"❌ Error retrieving agreement additions summary: {str(e)}"

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
    """
    Create a new addition for an agreement
    
    Args:
        agreement_id: The agreement ID to add the addition to
        product_id: The product ID for the addition
        quantity: Quantity of the product
        unit_price: Unit price for the product
        effective_date: Effective date (YYYY-MM-DD format)
        description: Optional description
        billable_option: Billable option (Billable, DoNotBill, NoCharge)
    """
    try:
        # Prepare addition data
        addition_data = {
            "product": {"id": product_id},
            "quantity": quantity,
            "unitPrice": unit_price,
            "effectiveDate": effective_date,
            "billableOption": billable_option
        }
        
        if description:
            addition_data["description"] = description
        
        # Create the addition
        result = await make_api_request("POST", f"/finance/agreements/{agreement_id}/additions", data=addition_data)
        
        if result and "id" in result:
            addition_id = result["id"]
            extended_price = result.get("extendedPrice", quantity * unit_price)
            
            response = f"✅ Successfully created agreement addition\n"
            response += f"Addition ID: {addition_id}\n"
            response += f"Agreement: {agreement_id}\n"
            response += f"Product ID: {product_id}\n"
            response += f"Quantity: {quantity}\n"
            response += f"Unit Price: ${unit_price:,.2f}\n"
            response += f"Extended Price: ${extended_price:,.2f}\n"
            response += f"Effective Date: {effective_date}\n"
            response += f"Billable Option: {billable_option}\n"
            
            return response
        else:
            return f"⚠️ Addition creation returned unexpected response: {result}"
        
    except APIError as e:
        return f"❌ Failed to create agreement addition: {e.message}"
    except Exception as e:
        return f"❌ Error creating agreement addition: {str(e)}"

@mcp.tool()
async def search_agreement_additions(
    company_id: Optional[int] = None,
    product_name: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    max_results: int = 20
) -> str:
    """
    Search for agreement additions across multiple agreements
    
    Args:
        company_id: Filter by company ID
        product_name: Filter by product name (partial match)
        date_from: Filter by effective date from (YYYY-MM-DD)
        date_to: Filter by effective date to (YYYY-MM-DD)
        max_results: Maximum results to return
    """
    try:
        result = f"🔍 Searching Agreement Additions\n"
        result += "=" * 50 + "\n\n"
        
        # Build conditions
        conditions = []
        if company_id:
            conditions.append(f"agreement/company/id={company_id}")
        if product_name:
            conditions.append(f"product/name contains '{product_name}'")
        if date_from:
            conditions.append(f"effectiveDate >= '{date_from}'")
        if date_to:
            conditions.append(f"effectiveDate <= '{date_to}'")
        
        # Note: This is a conceptual search - the actual API might not support
        # searching additions across all agreements directly
        result += "**Search Criteria:**\n"
        if company_id:
            result += f"• Company ID: {company_id}\n"
        if product_name:
            result += f"• Product Name: {product_name}\n"
        if date_from:
            result += f"• Date From: {date_from}\n"
        if date_to:
            result += f"• Date To: {date_to}\n"
        
        result += "\n**Note:** Direct cross-agreement addition search may not be supported.\n"
        result += "Consider using get_agreement_additions() for specific agreements.\n"
        
        # If we have a company_id, we can search their agreements first
        if company_id:
            try:
                agreements = await make_api_request(
                    "GET", 
                    "/finance/agreements",
                    params={"conditions": f"company/id={company_id}", "pageSize": 50}
                )
                
                result += f"\n**Found {len(agreements)} agreements for company {company_id}**\n\n"
                
                total_additions = 0
                for agreement in agreements:
                    agreement_id = agreement.get("id")
                    agreement_name = agreement.get("name", "Unknown")
                    
                    try:
                        additions = await make_api_request("GET", f"/finance/agreements/{agreement_id}/additions")
                        if additions:
                            total_additions += len(additions)
                            result += f"• {agreement_name} (ID: {agreement_id}): {len(additions)} additions\n"
                    except APIError:
                        result += f"• {agreement_name} (ID: {agreement_id}): No additions accessible\n"
                
                result += f"\n**Total additions found: {total_additions}**\n"
                
            except APIError as e:
                result += f"\n❌ Error searching company agreements: {e.message}\n"
        
        return result
        
    except Exception as e:
        return f"❌ Error searching agreement additions: {str(e)}"

@mcp.tool()
async def get_agreement_billing_summary(agreement_id: int) -> str:
    """
    Get comprehensive billing summary for an agreement including additions
    
    Args:
        agreement_id: The agreement ID to get billing summary for
    """
    try:
        result = f"💰 Agreement Billing Summary - Agreement #{agreement_id}\n"
        result += "=" * 60 + "\n\n"
        
        # Get agreement details
        try:
            agreement_info = await make_api_request("GET", f"/finance/agreements/{agreement_id}")
            
            result += f"**Agreement:** {agreement_info.get('name', 'Unknown')}\n"
            result += f"**Type:** {agreement_info.get('type', {}).get('name', 'Unknown')}\n"
            result += f"**Company:** {agreement_info.get('company', {}).get('name', 'Unknown')}\n"
            result += f"**Status:** {agreement_info.get('agreementStatus', 'Unknown')}\n"
            result += f"**Billing Cycle:** {agreement_info.get('billingCycle', {}).get('name', 'Unknown')}\n"
            result += f"**Bill Amount:** ${agreement_info.get('billAmount', 0):,.2f}\n"
            result += f"**Next Invoice:** {agreement_info.get('nextInvoiceDate', 'Unknown')}\n\n"
            
        except APIError as e:
            result += f"**Agreement:** {agreement_id} (details not accessible)\n\n"
        
        # Get additions summary
        result += "## 📋 Additions Summary\n"
        additions_summary = await get_agreement_additions_summary(agreement_id)
        
        # Extract relevant parts
        if "Total Additions:" in additions_summary:
            summary_lines = additions_summary.split('\n')
            for line in summary_lines:
                if "Total Additions:" in line or "Total Amount:" in line:
                    result += line + "\n"
        else:
            result += "No additions found\n"
        
        result += "\n"
        
        # Get recent invoices
        result += "## 🧾 Recent Invoices\n"
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
                result += f"**Found {len(invoices)} recent invoices**\n\n"
                
                for invoice in invoices:
                    result += f"• **{invoice.get('invoiceNumber', 'Unknown')}** - "
                    result += f"${invoice.get('total', 0):,.2f} - "
                    result += f"{invoice.get('date', 'Unknown')}\n"
            else:
                result += "No recent invoices found\n"
                
        except APIError as e:
            result += f"Could not retrieve invoices: {e.message}\n"
        
        return result
        
    except Exception as e:
        return f"❌ Error retrieving agreement billing summary: {str(e)}"

# Also update the execute_api_call function to handle additions endpoints specifically
# Add this modification to your existing execute_api_call function

async def execute_api_call_with_additions_support(
    path: str, 
    method: str = "GET", 
    params: Optional[Dict[str, Any]] = None, 
    data: Optional[Dict[str, Any]] = None
) -> str:
    """
    Enhanced execute_api_call with specific support for agreement additions
    """
    global current_query_from_fast_memory
    
    if not api_db:
        if not initialize_database():
            return "Error: Failed to initialize API database."
    
    # Check Fast Memory first
    fast_memory_entry = check_fast_memory(path, method)
    if fast_memory_entry:
        if params is None and 'params' in fast_memory_entry and fast_memory_entry['params']:
            params = fast_memory_entry['params']
        if data is None and 'data' in fast_memory_entry and fast_memory_entry['data']:
            data = fast_memory_entry['data']
    
    try:
        # Special handling for agreement additions endpoints
        if "/agreements/" in path and "/additions" in path:
            # Skip endpoint verification for additions - make direct API call
            result = await make_api_request(method, path, params, data)
        else:
            # Normal endpoint verification
            endpoint = api_db.find_endpoint_by_path_method(path, method)
            if not endpoint:
                return f"Warning: No documented API endpoint found for {method} {path}. Proceeding with caution."
            
            result = await make_api_request(method, path, params, data)
        
        # Format the response (same as original)
        response = ""
        if isinstance(result, list):
            if len(result) > 10:
                summary = f"Retrieved {len(result)} items. Showing first 10:"
                formatted_data = json.dumps(result[:10], indent=2)
                response = f"{summary}\n\n{formatted_data}\n\n(Response truncated. Full response contained {len(result)} items.)"
            else:
                response = json.dumps(result, indent=2)
        else:
            response = json.dumps(result, indent=2)
        
        # Add saving prompt if not from Fast Memory
        if not current_query_from_fast_memory:
            endpoint_details = format_endpoint_for_saving(method, path, params, data)
            response += f"\n\n=== SUCCESSFUL API CALL ===\n{endpoint_details}\n\nWould you like to save this query to Fast Memory for quicker access in the future?"
        else:
            current_query_from_fast_memory = False
            response = f"[Using query from Fast Memory: {fast_memory_entry['description']}]\n\n" + response
            
        return response
    
    except APIError as e:
        current_query_from_fast_memory = False
        return f"API Error ({e.status_code if e.status_code else 'Unknown'}): {e.message}"
    except Exception as e:
        current_query_from_fast_memory = False
        logger.error(f"Error executing API call: {str(e)}")
        return f"Error executing API call: {str(e)}"



if __name__ == "__main__":
    main()