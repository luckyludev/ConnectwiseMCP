#!/usr/bin/env python3
"""
ConnectWise API Gateway MCP Server - Main Entry Point

This script is the entry point for the ConnectWise API Gateway MCP server.
It imports and runs the actual server implementation.
"""

import sys
import os

# Add the current directory to the module search path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Import the main function from the server module
from api_gateway.server import main

if __name__ == "__main__":
    main()
