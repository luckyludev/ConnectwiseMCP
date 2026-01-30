# n8n Setup (MCP via HTTP Gateway)

This guide shows how to call the ConnectwiseMCP HTTP gateway from n8n.

## Prerequisites

- Gateway running (see `README.md` Docker setup)
- `MCP_STATIC_TOKEN` set in `deploy/http-gateway/.env`
- Gateway public URL: `https://connectwisemcp.funcshun.com`

## Option A: HTTP Request node (simple)

1) Add **HTTP Request** node.
2) Method: **POST**
3) URL: `https://connectwisemcp.funcshun.com/mcp`
4) Authentication: **None**
5) Headers:
   - `Authorization: Bearer YOUR_TOKEN`
   - `Content-Type: application/json`

6) Body (JSON):
```
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/list",
  "params": {}
}
```

Run the node to list MCP tools.

### Example: call a tool
Replace `method` with `tools/call` and set `params`:
```
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "search_api_endpoints",
    "arguments": {
      "query": "tickets",
      "max_results": 5
    }
  }
}
```

## Option B: n8n credentials (reusable)

Create a **Generic Credential** (or use HTTP Request with header injection) that stores:
- `Authorization: Bearer YOUR_TOKEN`

Then attach it to any HTTP Request node that calls the MCP gateway.

## Notes

- The MCP endpoint is `/mcp` for JSON-RPC calls.
- If you need streaming, use `/sse` and an SSE-capable node/plugin.
- Use `tools/list` first to confirm the tool names exposed by your server.
