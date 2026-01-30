// proxy-cwm-api.js

import http from "http";
import { spawn } from "child_process";

const MCP_CMD = ["node", "C:\\Users\\Luis\\CWM-API-Gateway-MCP\\bin\\server.js"];
const MCP_CWD = "C:\\Users\\Luis\\CWM-API-Gateway-MCP";
const PORT    = 8000;

// 1) Spawn the stdio MCP server:
const mcp = spawn(MCP_CMD[0], MCP_CMD.slice(1), {
  cwd: MCP_CWD,
  stdio: ["pipe","pipe","inherit"],
  env: process.env
});

// 2) Buffer stdout lines:
let buffer = "";
mcp.stdout.on("data", chunk => buffer += chunk.toString());

// Helper to write a line to stdin and await one-line response:
function getResponse(requestJson) {
  return new Promise(resolve => {
    // write JSON + newline
    mcp.stdin.write(JSON.stringify(requestJson) + "\n");
    // poll buffer for a full line
    const tryFlush = () => {
      const idx = buffer.indexOf("\n");
      if (idx === -1) return setTimeout(tryFlush, 5);
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      resolve(line);
    };
    tryFlush();
  });
}

// 3) HTTP server:
const server = http.createServer(async (req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405).end();
    return;
  }
  let body = "";
  for await (const chunk of req) body += chunk;
  let rpcReq;
  try {
    rpcReq = JSON.parse(body);
  } catch {
    res.writeHead(400).end("Invalid JSON");
    return;
  }

  try {
    const respLine = await getResponse(rpcReq);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(respLine);
  } catch (err) {
    res.writeHead(500).end(err.message);
  }
});

server.listen(PORT, () =>
  console.log(`Proxy for CWM‑API‑Gateway‑MCP listening at http://localhost:${PORT}`)
);
