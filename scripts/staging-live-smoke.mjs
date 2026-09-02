#!/usr/bin/env node
/**
 * Live staging smoke test.
 *
 * Runs the FULL user flow against a deployed ConnectWise MCP worker:
 * DCR -> consent -> Microsoft login (browser) -> callback -> token -> MCP
 * `initialize` -> `get_my_member` -> `call_connectwise service.boards.statuses`.
 *
 * Success criteria (the "data is flowing" gate):
 *   1. get_my_member returns a member with id 149 (Luis) by default;
 *      with SMOKE_EXPECT_MEMBER_ID set, that id is required.
 *   2. service.boards.statuses for board 32 returns at least one status.
 *
 * Security: output is allowlisted. It never prints response bodies, access
 * tokens, authorization URLs/codes, client secrets, state, or business data.
 *
 * Usage:
 *   node scripts/staging-live-smoke.mjs
 * Env:
 *   SMOKE_BASE_URL        (default: staging worker)
 *   SMOKE_EXPECT_MEMBER_ID (default: 149)
 *   SMOKE_BOARD_ID         (default: 32)
 *   SMOKE_NO_BROWSER       (fail closed instead of opening a browser)
 */

import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import process from "node:process";
import { readBoundedJson, readBoundedText } from "./smoke-response.mjs";

const BASE_URL = (
  process.env.SMOKE_BASE_URL ??
  "https://connectwise-mcp-v2-staging.funcshun.workers.dev"
).replace(/\/+$/, "");
const EXPECT_MEMBER_ID = Number(process.env.SMOKE_EXPECT_MEMBER_ID ?? "149");
const BOARD_ID = Number(process.env.SMOKE_BOARD_ID ?? "32");
const LOGIN_TIMEOUT_MS = Number(process.env.SMOKE_LOGIN_TIMEOUT_MS ?? 420_000);
const HTTP_TIMEOUT_MS = 30_000;

const log = (...parts) => console.log("[smoke]", ...parts);
const smokeFetch = (input, init = {}) =>
  globalThis.fetch(input, {
    ...init,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });

function base64url(bytes) {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fail(message) {
  log("FAIL", message);
  process.exit(1);
}

function failUnexpectedly() {
  log("FAIL unexpected smoke failure");
  process.exit(1);
}
process.on("uncaughtException", failUnexpectedly);
process.on("unhandledRejection", failUnexpectedly);

if (process.env.SMOKE_NO_BROWSER && !process.env.SMOKE_ACCESS_TOKEN) {
  fail("browser launch disabled; provide an approved access token instead");
}

// 1. Loopback server to receive the OAuth callback.
const loopback = await new Promise((resolve, reject) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/callback") {
      callbackSeen = {
        code: url.searchParams.get("code"),
        state: url.searchParams.get("state"),
      };
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("OAuth complete. You can close this tab.");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(0, "127.0.0.1", () => {
    resolve(server);
  });
  server.on("error", reject);
});
const server = loopback;
const loopbackPort = server.address().port;
const loopbackRedirectUri = `http://127.0.0.1:${loopbackPort}/callback`;
let callbackSeen = null;

// 2. Canonical resource (for the `resource` parameter).
const resourceResponse = await smokeFetch(
  `${BASE_URL}/.well-known/oauth-protected-resource`,
);
if (!resourceResponse.ok) {
  await resourceResponse.body?.cancel();
  fail(`protected-resource discovery failed (${resourceResponse.status})`);
}
const resourceMeta = await readBoundedJson(resourceResponse, null);
if (typeof resourceMeta?.resource !== "string") {
  fail("protected-resource discovery returned invalid metadata");
}
let canonicalResource;
try {
  canonicalResource = new URL(resourceMeta.resource);
} catch {
  fail("protected-resource discovery returned invalid metadata");
}
const expectedResource = new URL("/mcp", `${BASE_URL}/`);
if (
  canonicalResource.username ||
  canonicalResource.password ||
  canonicalResource.hash ||
  canonicalResource.toString() !== expectedResource.toString()
) {
  fail("protected-resource discovery returned unexpected metadata");
}
canonicalResource = canonicalResource.toString();

// 3. Token acquisition.
//
// Fast path: when SMOKE_ACCESS_TOKEN is set (CI / no-browser runs), reuse it
// directly and skip the DCR + consent flow below.
let token;
if (process.env.SMOKE_ACCESS_TOKEN) {
  token = {
    access_token: process.env.SMOKE_ACCESS_TOKEN,
    scope: "mcp:read",
  };
  log(
    `using SMOKE_ACCESS_TOKEN (length ${token.access_token.length}) - skipping DCR/consent`,
  );
} else {
  // 3a. Dynamic client registration (loopback).
  const registerResponse = await smokeFetch(`${BASE_URL}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "staging-live-smoke",
      redirect_uris: [loopbackRedirectUri],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_basic",
    }),
  });
  if (!registerResponse.ok) {
    await registerResponse.body?.cancel();
    fail(`DCR rejected (${registerResponse.status})`);
  }
  const registration = await readBoundedJson(registerResponse, {});
  if (!registration.client_id || !registration.client_secret) {
    fail("DCR response missing required fields");
  }
  log(`DCR ok (client_id length ${registration.client_id.length})`);

  // 4. PKCE.
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = base64url(randomBytes(16));

  // 5. Open the consent page IN THE BROWSER.
  //
  // The worker's /callback requires the session cookie that the worker sets
  // while the browser itself walks /authorize -> POST /authorize -> Entra.
  // Driving those steps from Node (and opening only the Entra URL) drops the
  // cookie and fails with 400, so the browser must perform the full worker
  // leg, exactly like a real MCP client (Claude, ChatGPT) would.
  const authorizeUrl = new URL(`${BASE_URL}/authorize`);
  authorizeUrl.searchParams.set("client_id", registration.client_id);
  authorizeUrl.searchParams.set("redirect_uri", loopbackRedirectUri);
  authorizeUrl.searchParams.set("scope", "mcp:read");
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("resource", canonicalResource);

  log("Opening the ConnectWise consent page in your browser.");
  log("Click 'Continue with Microsoft' and complete sign-in.");
  const opener = spawn("open", [authorizeUrl.toString()], {
    stdio: "ignore",
  });
  await new Promise((resolve) => {
    opener.once("error", () => fail("browser launch failed"));
    opener.once("close", (code) => {
      if (code !== 0) fail("browser launch failed");
      resolve();
    });
  });

  // 7. Wait for the loopback callback.
  log(
    `Waiting up to ${Math.round(LOGIN_TIMEOUT_MS / 1000)}s for you to sign in...`,
  );
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  while (!callbackSeen && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!callbackSeen || !callbackSeen.code) {
    fail("timed out waiting for the Microsoft login callback");
  }
  if (callbackSeen.state !== state) {
    fail("callback state mismatch");
  }
  log("Authorization code received (value not printed).");

  // 8. Exchange the code for a token (PKCE + client secret).
  async function tokenRequest(headers) {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: callbackSeen.code,
      code_verifier: verifier,
      client_id: registration.client_id,
      redirect_uri: loopbackRedirectUri,
    });
    return smokeFetch(`${BASE_URL}/oauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        ...headers,
      },
      body: body.toString(),
    });
  }
  let tokenResponse = await tokenRequest({
    Authorization: `Basic ${Buffer.from(
      `${registration.client_id}:${registration.client_secret}`,
    ).toString("base64")}`,
  });
  if (!tokenResponse.ok) {
    await tokenResponse.body?.cancel();
    fail(`token exchange failed (${tokenResponse.status})`);
  }
  token = await readBoundedJson(tokenResponse, {});
  if (!token.access_token) {
    fail("token response missing access_token");
  }
  log(`token ok (length ${token.access_token.length})`);
}
if (!token?.access_token) {
  fail(
    "no access token available (set SMOKE_ACCESS_TOKEN or complete the consent flow)",
  );
}

// 9. MCP streamable-HTTP session.
const mcpHeaders = (extra = {}) => ({
  Authorization: `Bearer ${token.access_token}`,
  Accept: "application/json, text/event-stream",
  "Content-Type": "application/json",
  "MCP-Protocol-Version": "2025-06-18",
  ...extra,
});

async function mcpCall(payload, sessionId) {
  const response = await smokeFetch(`${BASE_URL}/mcp`, {
    method: "POST",
    headers: mcpHeaders(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
    body: JSON.stringify(payload),
  });
  const contentType = response.headers.get("content-type") ?? "";
  const text = await readBoundedText(response);
  let parsed = null;
  if (contentType.includes("text/event-stream")) {
    for (const line of text.split("\n")) {
      if (line.startsWith("data:")) {
        try {
          parsed = JSON.parse(line.slice(5).trim());
        } catch {
          // keep looking
        }
      }
    }
  } else {
    try {
      parsed = JSON.parse(text);
    } catch {
      // not JSON
    }
  }
  return {
    status: response.status,
    sessionId: response.headers.get("mcp-session-id") ?? sessionId,
    parsed,
  };
}

const init = await mcpCall(
  {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "staging-live-smoke", version: "1.0.0" },
    },
  },
  null,
);
if (init.status !== 200 || !init.parsed?.result) {
  fail(`MCP initialize failed (${init.status})`);
}
log("MCP session established");

await mcpCall(
  { jsonrpc: "2.0", method: "notifications/initialized" },
  init.sessionId,
);

// Gate 0: tools/list must expose every expected tool. A tool that passes its
// own unit tests but is not registered looks identical to a nonexistent tool.
log("requesting tools/list ...");
const toolsListResp = await mcpCall(
  { jsonrpc: "2.0", id: Date.now(), method: "tools/list" },
  init.sessionId,
);
if (
  toolsListResp.status !== 200 ||
  toolsListResp.parsed?.error ||
  !Array.isArray(toolsListResp.parsed?.result?.tools)
) {
  fail("tools/list failed");
}
const registeredTools = (toolsListResp.parsed?.result?.tools ?? []).map(
  (t) => t.name,
);
const expectedTools = [
  "whoami",
  "get_service_ticket",
  "search_tickets_by_content",
  "get_ticket_notes_with_content",
  "get_ticket_attachments_with_details",
  "get_complete_ticket_content",
  "create_ticket_note",
  "attach_image_to_ticket",
  "attach_image_to_time_entry",
  "get_service_boards",
  "get_board_options",
  "list_board_tickets",
  "get_service_statuses",
  "get_service_priorities",
  "get_service_sources",
  "get_my_member",
  "list_members",
  "search_companies",
  "search_contacts",
  "list_time_entries",
  "list_schedule_entries",
  "get_time_sheets",
  "get_document",
  "download_document",
  "open_attachment_uploader",
  "upload_connectwise_image",
  "call_connectwise",
  "get_agreement_additions",
  "get_agreement_additions_summary",
  "create_agreement_addition",
  "search_agreement_additions",
  "get_agreement_billing_summary",
  "create_schedule_entry",
  "update_schedule_entry",
  "delete_schedule_entry",
  "create_time_entry",
  "create_service_ticket",
  "update_service_ticket",
];
const missing = expectedTools.filter((name) => !registeredTools.includes(name));
if (missing.length > 0) {
  fail(`tools/list is missing ${missing.length} expected tool(s)`);
}
const forbidden = ["execute_api_call"].filter((name) =>
  registeredTools.includes(name),
);
if (forbidden.length > 0) {
  fail(`tools/list exposes forbidden generic tool(s): ${forbidden.join(", ")}`);
}
const unexpected = registeredTools.filter(
  (name) => !expectedTools.includes(name),
);
if (unexpected.length > 0) {
  fail(`tools/list exposes ${unexpected.length} unexpected tool(s)`);
}
log(
  `tools/list ok (${registeredTools.length} registered; expected catalog present)`,
);

async function callTool(name, args) {
  const result = await mcpCall(
    {
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name, arguments: args },
    },
    init.sessionId,
  );
  if (result.status !== 200) {
    return {
      ok: false,
      reason: `http_${result.status}`,
    };
  }
  const payload = result.parsed;
  if (payload?.error) {
    return { ok: false, reason: "mcp_error" };
  }
  const toolResult = payload?.result;
  const text = toolResult?.content
    ?.filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  let data;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  return {
    ok: !toolResult?.isError,
    data,
    reason: toolResult?.isError ? "tool_error" : undefined,
  };
}

// 10. Gate 1: get_my_member.
log("calling get_my_member ...");
const member = await callTool("get_my_member", {});
if (!member.ok) {
  fail(`get_my_member failed (${member.reason})`);
}
const memberId = member.data?.member?.id ?? member.data?.id;
if (memberId !== EXPECT_MEMBER_ID) {
  fail("get_my_member identity mismatch");
}
log("get_my_member ok (expected identity matched)");

// 11. Gate 2: board statuses via the catalog tool.
log("calling call_connectwise service.boards.statuses ...");
const statuses = await callTool("call_connectwise", {
  route: "service.boards.statuses",
  boardId: BOARD_ID,
});
if (!statuses.ok) {
  fail(`call_connectwise service.boards.statuses failed (${statuses.reason})`);
}
const statusList = Array.isArray(statuses.data)
  ? statuses.data
  : statuses.data?.items;
if (!Array.isArray(statusList) || statusList.length === 0) {
  fail("board statuses came back empty");
}
log("board statuses ok");

// 12. Gate 3: fixed-route schedule catalog date range.
log("calling call_connectwise schedule.entries.byMember (date range) ...");
const schedule = await callTool("call_connectwise", {
  route: "schedule.entries.byMember",
  memberId: EXPECT_MEMBER_ID,
  startDate: "2026-08-31",
  endDate: "2026-09-06",
});
const scheduleList = Array.isArray(schedule.data) ? schedule.data : [];
if (!schedule.ok || scheduleList.length === 0) {
  fail(`schedule.entries.byMember failed (${schedule.reason ?? "empty"})`);
}
log("schedule.entries.byMember ok");

// 13. Done. The smoke remains read-only; write acceptance requires a separately
// authorized staging procedure and an access token carrying mcp:write.
server.close();
log("PASS: staging worker is fully operational (auth + ConnectWise data).");
process.exit(0);
