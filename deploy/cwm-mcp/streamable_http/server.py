#!/usr/bin/env python3
"""
HTTP-streamable entry point for the ConnectWise API Gateway MCP server.

This reuses the existing FastMCP tools but exposes them over the
Streamable HTTP transport instead of stdio/SSE.
"""

import os
import sys
from pathlib import Path

# Ensure the repo root is on sys.path so api_gateway imports resolve
ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from api_gateway.server import (  # noqa: E402
    initialize_database,
    initialize_fast_memory,
    logger,
    mcp,
    setup_config,
)


def configure_http_transport():
    """Configure host/port/path for Streamable HTTP from environment."""
    host = os.getenv("MCP_SERVER_HOST", os.getenv("SERVER_HOST", "0.0.0.0"))
    port = int(os.getenv("MCP_SERVER_PORT", os.getenv("SERVER_PORT", "8000")))
    path = os.getenv("MCP_STREAM_PATH")

    mcp.settings.host = host
    mcp.settings.port = port
    if path:
        mcp.settings.streamable_http_path = path

    return host, port, mcp.settings.streamable_http_path


def main():
    logger.info("Starting ConnectWise API Gateway MCP (HTTP transport)")
    setup_config()
    initialize_database()
    initialize_fast_memory()
    # Initialize session manager to avoid first-request overhead/validation errors
    mcp.streamable_http_app()
    host, port, path = configure_http_transport()
    logger.info(f"HTTP transport configured: host={host} port={port} path={path}")
    mcp.run(transport="streamable-http")


if __name__ == "__main__":
    main()
