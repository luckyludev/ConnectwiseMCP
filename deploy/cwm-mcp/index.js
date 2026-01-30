// This file is the main entry point for the package
// It provides information about the package

/**
 * ConnectWise API Gateway MCP Server
 * 
 * This package provides a Model Context Protocol (MCP) server
 * for interacting with the ConnectWise Manage API.
 * 
 * @module @jasondsmith72/cwm-api-gateway-mcp
 */

module.exports = {
  /**
   * Returns information about this package.
   * 
   * @returns {Object} Package information
   */
  getInfo: function() {
    return {
      name: '@jasondsmith72/cwm-api-gateway-mcp',
      description: 'ConnectWise API Gateway MCP Server for Claude',
      version: require('./package.json').version,
      repository: 'https://github.com/jasondsmith72/CWM-API-Gateway-MCP'
    };
  },
  
  /**
   * Path to the server script.
   */
  serverPath: require('path').join(__dirname, 'bin', 'server.js')
};
