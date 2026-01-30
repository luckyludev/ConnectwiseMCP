# ConnectWise API Gateway MCP Server

This Model Context Protocol (MCP) server provides a comprehensive interface for interacting with the ConnectWise Manage API. It simplifies API discovery, execution, and management for both developers and AI assistants.

## Core Capabilities

- **API Discovery:** Search for and explore ConnectWise API endpoints using keywords or natural language
- **Simplified API Execution:** Execute API calls with friendly parameter handling and automatic error management
- **Fast Memory System:** Save and retrieve frequently used API queries for more efficient workflows
- **Raw API Access:** Send custom API requests with complete control over endpoints, methods, and parameters

## Key Features

- **Database-Backed API Discovery:** Uses a SQLite database built from the ConnectWise API definition JSON for fast, efficient endpoint lookups
- **Natural Language Search:** Find relevant API endpoints using conversational descriptions of what you need
- **Categorized API Navigation:** Browse API endpoints organized by functional categories
- **Detailed Documentation Access:** View comprehensive information about API endpoints including parameters, schemas, and response formats
- **Adaptive Learning:** The system learns which API calls are most valuable to you through usage tracking

## Installation & Setup

### Prerequisites

- Python 3.10 or higher
- Access to ConnectWise Manage API credentials
- ConnectWise API definition file (`manage.json`) - included in the repository

### Installation Steps

#### Windows

1. **Clone or download the repository:**
   ```bash
   git clone https://github.com/jasondsmith72/CWM-API-Gateway-MCP.git
   cd CWM-API-Gateway-MCP
   ```

2. **Install the package:**
   ```bash
   pip install -e .
   ```

#### macOS

1. **Install Python 3.10+ if not already installed:**
   ```bash
   # Using Homebrew
   brew install python@3.10
   
   # Or using pyenv
   brew install pyenv
   pyenv install 3.10.0
   pyenv global 3.10.0
   ```

2. **Clone the repository:**
   ```bash
   git clone https://github.com/jasondsmith72/CWM-API-Gateway-MCP.git
   cd CWM-API-Gateway-MCP
   ```

3. **Set up a virtual environment (recommended):**
   ```bash
   python3 -m venv venv
   source venv/bin/activate
   ```

4. **Install the package:**
   ```bash
   pip install -e .
   ```

#### Linux (Ubuntu/Debian)

1. **Install Python 3.10+ if not already installed:**
   ```bash
   # For Ubuntu 22.04+
   sudo apt update
   sudo apt install python3.10 python3.10-venv python3.10-dev python3-pip
   
   # For older versions of Ubuntu/Debian
   sudo add-apt-repository ppa:deadsnakes/ppa
   sudo apt update
   sudo apt install python3.10 python3.10-venv python3.10-dev python3-pip
   ```

2. **Clone the repository:**
   ```bash
   git clone https://github.com/jasondsmith72/CWM-API-Gateway-MCP.git
   cd CWM-API-Gateway-MCP
   ```

3. **Set up a virtual environment (recommended):**
   ```bash
   python3.10 -m venv venv
   source venv/bin/activate
   ```

4. **Install the package:**
   ```bash
   pip install -e .
   ```

### Post-Installation Steps

After installing on any platform (Windows, macOS, or Linux), complete the following steps:

#### 1. (Optional) Build the API Database

This repository already includes a pre-built database, so this step is optional. Only run this if you need to use a newer ConnectWise API definition file:

```bash
# On Windows
python build_database.py path/to/manage.json

# On macOS/Linux
python3 build_database.py path/to/manage.json
```

This step only needs to be done once, or whenever the ConnectWise API definition changes.

#### 2. Configure API Credentials

Set the following environment variables with your ConnectWise credentials:
```
CONNECTWISE_API_URL=https://your-instance.connectwise.com/v4_6_release/apis/3.0
CONNECTWISE_COMPANY_ID=your_company_id
CONNECTWISE_PUBLIC_KEY=your_public_key
CONNECTWISE_PRIVATE_KEY=your_private_key
CONNECTWISE_AUTH_PREFIX=yourprefix+  # Prefix required by ConnectWise for API authentication
```

These credentials are used in the authentication process as follows:

- **CONNECTWISE_API_URL**: The base URL for all API requests to your ConnectWise instance
  ```
  url = f"{API_URL}{endpoint}"  # e.g., https://your-instance.connectwise.com/v4_6_release/apis/3.0/service/tickets
  ```

- **CONNECTWISE_COMPANY_ID**: Included in the 'clientId' header of each request to identify your company
  ```
  headers = {'clientId': COMPANY_ID, ...}
  ```

- **CONNECTWISE_PUBLIC_KEY** and **CONNECTWISE_PRIVATE_KEY**: Used together with AUTH_PREFIX to create the basic authentication credentials
  ```
  username = f"{AUTH_PREFIX}{PUBLIC_KEY}"  # e.g., "yourprefix+your_public_key"
  password = PRIVATE_KEY
  credentials = f"{username}:{password}"  # Combined into "yourprefix+your_public_key:your_private_key"
  ```

- **CONNECTWISE_AUTH_PREFIX**: Required prefix added before your public key in the authentication username. ConnectWise API requires this prefix to identify the type of integration (e.g., "api+", "integration+", etc.)

The final HTTP headers sent with every request will look like:
```
'Authorization': 'Basic [base64 encoded credentials]'
'clientId': 'your_company_id'
'Content-Type': 'application/json'
```

## Configuration for Claude Desktop

To integrate with Claude Desktop, add the following to your configuration file (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "api_gateway": {
      "command": "python",
      "args": ["C:/path/to/CWM-API-Gateway-MCP/api_gateway_server.py"],
      "env": {
        "CONNECTWISE_API_URL": "https://your-instance.connectwise.com/v4_6_release/apis/3.0",
        "CONNECTWISE_COMPANY_ID": "your_company_id",
        "CONNECTWISE_PUBLIC_KEY": "your_public_key",
        "CONNECTWISE_PRIVATE_KEY": "your_private_key",
        "CONNECTWISE_AUTH_PREFIX": "yourprefix+"
      }
    }
  }
}
```

For macOS and Linux, use the appropriate path format:

```json
{
  "mcpServers": {
    "api_gateway": {
      "command": "python3",
      "args": ["/path/to/CWM-API-Gateway-MCP/api_gateway_server.py"],
      "env": {
        "CONNECTWISE_API_URL": "https://your-instance.connectwise.com/v4_6_release/apis/3.0",
        "CONNECTWISE_COMPANY_ID": "your_company_id",
        "CONNECTWISE_PUBLIC_KEY": "your_public_key",
        "CONNECTWISE_PRIVATE_KEY": "your_private_key",
        "CONNECTWISE_AUTH_PREFIX": "yourprefix+"
      }
    }
  }
}
```

The server can be run directly from the command line for testing:

```bash
# On Windows
python api_gateway_server.py

# On macOS/Linux
python3 api_gateway_server.py
```

## Available Tools

The API Gateway MCP server provides several tools for working with the ConnectWise API:

### API Discovery Tools

| Tool | Description |
|------|-------------|
| `search_api_endpoints` | Search for API endpoints by query string |
| `natural_language_api_search` | Find endpoints using natural language descriptions |
| `list_api_categories` | List all available API categories |
| `get_category_endpoints` | List all endpoints in a specific category |
| `get_api_endpoint_details` | Get detailed information about a specific endpoint |

### API Execution Tools

| Tool | Description |
|------|-------------|
| `execute_api_call` | Execute an API call with path, method, parameters, and data |
| `send_raw_api_request` | Send a raw API request in the format "METHOD /path [JSON body]" |

### Fast Memory Tools

| Tool | Description |
|------|-------------|
| `save_to_fast_memory` | Manually save an API query to Fast Memory |
| `list_fast_memory` | List all queries saved in Fast Memory |
| `delete_from_fast_memory` | Delete a specific query from Fast Memory |
| `clear_fast_memory` | Clear all queries from Fast Memory |

## Usage Examples

### Search for Ticket-Related Endpoints

```python
search_api_endpoints("tickets")
```

### Search Using Natural Language

```python
natural_language_api_search("find all open service tickets that are high priority")
```

### Execute a GET Request

```python
execute_api_call(
    "/service/tickets", 
    "GET", 
    {"conditions": "status/name='Open' and priority/name='High'"}
)
```

### Create a New Service Ticket

```python
execute_api_call(
    "/service/tickets", 
    "POST", 
    None,  # No query parameters 
    {
        "summary": "Server is down",
        "board": {"id": 1},
        "company": {"id": 2},
        "status": {"id": 1},
        "priority": {"id": 3}
    }
)
```

### Send a Raw API Request

```python
send_raw_api_request("GET /service/tickets?conditions=status/name='Open'")
```

### View Fast Memory Contents

```python
list_fast_memory()
```

### Save a Useful Query to Fast Memory

```python
save_to_fast_memory(
    "/service/tickets", 
    "GET", 
    "Get all high priority open tickets", 
    {"conditions": "status/name='Open' and priority/name='High'"}
)
```

## Understanding Fast Memory

The Fast Memory feature allows you to save and retrieve frequently used API queries, optimizing your workflow in several ways:

### Benefits

- **Time Savings:** Quickly execute complex API calls without remembering exact endpoints or parameters
- **Error Reduction:** Reuse successful API calls to minimize potential errors
- **Adaptive Learning:** The system learns which API calls are most valuable to you
- **Parameter Persistence:** Parameters and request bodies are stored for future use

### How It Works

1. **Automatic Learning:** When you execute a successful API call, you're prompted to save it to Fast Memory
2. **Intelligent Retrieval:** The next time you use the same API endpoint, the system checks Fast Memory first
3. **Parameter Reuse:** If you don't provide parameters for a call, the system automatically uses those saved in Fast Memory
4. **Usage Tracking:** The system tracks how often each query is used and prioritizes frequently used queries

### Fast Memory Functionality

- **Automatic Parameter Suggestion:** The system will suggest parameters from Fast Memory if none are provided
- **Usage Counter:** Each time a query from Fast Memory is used, its usage count increases
- **Search Capability:** Search through your saved queries by description or endpoint path
- **Prioritization:** Queries are displayed in order of usage frequency, with most frequently used queries at the top

### Managing Your Fast Memory

- **View Saved Queries:** `list_fast_memory()`
- **Search Specific Queries:** `list_fast_memory("search term")`
- **Delete a Query:** `delete_from_fast_memory(query_id)`
- **Clear All Queries:** `clear_fast_memory()`

### Fast Memory Technical Details

The Fast Memory system is powered by a SQLite database (`fast_memory_api.db`) that stores:

- Query paths and methods
- Parameters and request bodies as JSON
- Usage metrics and timestamps
- User-friendly descriptions

The database structure includes:
- `id`: Unique identifier for each saved query
- `description`: User-provided description of what the query does
- `path`: API endpoint path
- `method`: HTTP method (GET, POST, PUT, etc.)
- `params`: Query parameters in JSON format
- `data`: Request body in JSON format
- `timestamp`: When the query was last used
- `usage_count`: How many times the query has been used

## Troubleshooting

### Common Issues

#### Database Not Found Error

```
Error: Database file not found at [path]
Please run build_database.py script first to generate the database
```

**Solution:** Run the `build_database.py` script with the path to your ConnectWise API definition file:
```bash
python build_database.py path/to/manage.json
```

#### API Authentication Issues

```
HTTP error 401: Unauthorized
```

**Solution:** Check your environment variables to ensure all ConnectWise credentials are correct:
- Verify your `CONNECTWISE_COMPANY_ID`, `CONNECTWISE_PUBLIC_KEY`, and `CONNECTWISE_PRIVATE_KEY`
- Ensure the API key has the necessary permissions in ConnectWise
- Check that `CONNECTWISE_AUTH_PREFIX` is set correctly for your environment

#### Timeouts on API Calls

```
Request timed out. ConnectWise API may be slow to respond.
```

**Solution:** 
- Check your internet connection
- The ConnectWise API may be experiencing high load
- For large data requests, consider adding more specific filters to your query

### Logs and Diagnostics

#### Log Locations

- Main log file: `api_gateway/api_gateway.log`
- SQLite databases:
  - API Database: `api_gateway/connectwise_api.db`
  - Fast Memory Database: `api_gateway/fast_memory_api.db`

#### Testing the Database

Verify that the database is correctly built and accessible:
```bash
python test_database.py
```

This will display statistics about the database and confirm it can be queried properly.

## Advanced Usage

### Optimizing API Queries

For better performance with the ConnectWise API:

1. **Use Specific Conditions:** Narrow your queries with precise conditions
   ```python
   execute_api_call("/service/tickets", "GET", {
       "conditions": "status/name='Open' AND dateEntered > [2023-01-01T00:00:00Z]"
   })
   ```

2. **Limit Field Selection:** Request only the fields you need
   ```python
   execute_api_call("/service/tickets", "GET", {
       "conditions": "status/name='Open'",
       "fields": "id,summary,status,priority"
   })
   ```

3. **Paginate Large Results:** Use page and pageSize parameters
   ```python
   execute_api_call("/service/tickets", "GET", {
       "conditions": "status/name='Open'",
       "page": 1,
       "pageSize": 50
   })
   ```

## License

This software is proprietary and confidential. Unauthorized copying, distribution, or use is prohibited.

## Acknowledgments

- Built using the Model Context Protocol (MCP) framework
- Powered by ConnectWise Manage API