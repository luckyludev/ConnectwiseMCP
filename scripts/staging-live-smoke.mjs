#!/usr/bin/env node
/**
 * Live staging smoke test.
 *
 * Runs either the interactive user flow against a deployed ConnectWise MCP
 * Worker (DCR -> consent -> Microsoft login -> callback -> token), or a
 * supplied-token mode that skips the OAuth login and token-acquisition flow.
 * Both modes then run MCP `initialize`, `get_my_member`,
 * `call_connectwise service.boards.statuses`, and a bounded schedule read.
 *
 * This is a narrow read-path probe, not full staging acceptance. Success does
 * not cover multi-user isolation, revocation, permission denial, audit review,
 * or any other manual acceptance-checklist gate.
 *
 * Security: output is allowlisted. It never prints response bodies, access
 * tokens, authorization URLs/codes, client secrets, state, or business data.
 *
 * Usage:
 *   node scripts/staging-live-smoke.mjs
 * Env:
 *   SMOKE_BASE_URL          (default: staging worker; canonical HTTPS origin)
 *   SMOKE_EXPECT_RESOURCE   (required with a non-default base URL)
 *   SMOKE_EXPECT_MEMBER_ID  (default: 149)
 *   SMOKE_BOARD_ID          (default: 32)
 *   SMOKE_SCHEDULE_START_DATE (required; YYYY-MM-DD)
 *   SMOKE_SCHEDULE_END_DATE   (required; YYYY-MM-DD; at most 7 days inclusive)
 *   SMOKE_NO_BROWSER        (fail closed instead of opening a browser)
 *
 * Tests may set SMOKE_ALLOW_INSECURE_LOCALHOST=1 for an HTTP loopback mock.
 */

import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import process from "node:process";
import {
  CallToolResultSchema,
  InitializeResultSchema,
  JSONRPCResultResponseSchema,
  ListToolsResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readBoundedJson, readBoundedText } from "./smoke-response.mjs";
import {
  EXPECTED_TOOL_NAMES,
  validateStagingToolsListResult,
} from "./staging-tool-catalog.mjs";
import { bearerResourceMetadata } from "./www-authenticate.mjs";

const DEFAULT_BASE_URL =
  "https://connectwise-mcp-v2-staging.funcshun.workers.dev";
const DEFAULT_RESOURCE = `${DEFAULT_BASE_URL}/mcp`;
const HTTP_TIMEOUT_MS = 30_000;
const log = (...parts) => console.log("[smoke]", ...parts);

function fail(message) {
  log("FAIL", message);
  process.exit(1);
}

function parsePositiveInteger(name, fallback, maximum) {
  const raw = process.env[name] ?? String(fallback);
  if (!/^[1-9]\d*$/.test(raw)) {
    fail(`${name} must be a positive integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > maximum) {
    fail(`${name} is outside the allowed range`);
  }
  return value;
}

function parseCalendarDate(name, raw) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) fail(`${name} must be a valid YYYY-MM-DD date`);

  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    fail(`${name} must be a valid YYYY-MM-DD date`);
  }
  return { input: raw, timestamp };
}

function parseScheduleRange() {
  const startRaw = process.env.SMOKE_SCHEDULE_START_DATE;
  const endRaw = process.env.SMOKE_SCHEDULE_END_DATE;
  if (!startRaw || !endRaw) {
    fail("SMOKE_SCHEDULE_START_DATE and SMOKE_SCHEDULE_END_DATE are required");
  }

  const start = parseCalendarDate("SMOKE_SCHEDULE_START_DATE", startRaw);
  const end = parseCalendarDate("SMOKE_SCHEDULE_END_DATE", endRaw);
  const dayMs = 24 * 60 * 60 * 1000;
  if (end.timestamp < start.timestamp) {
    fail("SMOKE_SCHEDULE_END_DATE must not precede SMOKE_SCHEDULE_START_DATE");
  }
  if (end.timestamp - start.timestamp > 6 * dayMs) {
    fail("smoke schedule range must not exceed 7 days inclusive");
  }
  return { startDate: start.input, endDate: end.input };
}

function parseTarget() {
  const configured = process.env.SMOKE_BASE_URL ?? DEFAULT_BASE_URL;
  let base;
  try {
    base = new URL(configured);
  } catch {
    fail("SMOKE_BASE_URL must be a canonical HTTPS origin");
  }

  const insecureLoopbackAllowed =
    process.env.NODE_ENV === "test" &&
    process.env.SMOKE_ALLOW_INSECURE_LOCALHOST === "1" &&
    base.protocol === "http:" &&
    (base.hostname === "127.0.0.1" || base.hostname === "[::1]");
  if (
    (base.protocol !== "https:" && !insecureLoopbackAllowed) ||
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash ||
    configured !== base.origin
  ) {
    fail("SMOKE_BASE_URL must be a canonical HTTPS origin");
  }

  const expected = process.env.SMOKE_EXPECT_RESOURCE;
  if (base.origin !== DEFAULT_BASE_URL && !expected) {
    fail("SMOKE_EXPECT_RESOURCE is required with a non-default base URL");
  }
  let resource;
  try {
    resource = new URL(expected ?? DEFAULT_RESOURCE);
  } catch {
    fail("SMOKE_EXPECT_RESOURCE must be the target origin plus /mcp");
  }
  if (
    resource.username ||
    resource.password ||
    resource.search ||
    resource.hash ||
    resource.origin !== base.origin ||
    resource.pathname !== "/mcp" ||
    resource.toString() !== `${base.origin}/mcp`
  ) {
    fail("SMOKE_EXPECT_RESOURCE must be the target origin plus /mcp");
  }
  return { baseUrl: base.origin, expectedResource: resource.toString() };
}

if (process.env.SMOKE_NO_BROWSER && !process.env.SMOKE_ACCESS_TOKEN) {
  fail("browser launch disabled; provide an approved access token instead");
}

const { baseUrl: BASE_URL, expectedResource: EXPECTED_RESOURCE } =
  parseTarget();
const EXPECT_MEMBER_ID = parsePositiveInteger(
  "SMOKE_EXPECT_MEMBER_ID",
  149,
  2_147_483_647,
);
const BOARD_ID = parsePositiveInteger("SMOKE_BOARD_ID", 32, 2_147_483_647);
const LOGIN_TIMEOUT_MS = parsePositiveInteger(
  "SMOKE_LOGIN_TIMEOUT_MS",
  420_000,
  900_000,
);
if (LOGIN_TIMEOUT_MS < 1_000) {
  fail("SMOKE_LOGIN_TIMEOUT_MS is outside the allowed range");
}
const { startDate: SCHEDULE_START_DATE, endDate: SCHEDULE_END_DATE } =
  parseScheduleRange();

const smokeFetch = (input, init = {}) =>
  globalThis.fetch(input, {
    ...init,
    redirect: "manual",
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });

function base64url(bytes) {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function failUnexpectedly() {
  log("FAIL unexpected smoke failure");
  process.exit(1);
}
process.on("uncaughtException", failUnexpectedly);
process.on("unhandledRejection", failUnexpectedly);

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
const expectedResource = new URL(EXPECTED_RESOURCE);
if (
  canonicalResource.username ||
  canonicalResource.password ||
  canonicalResource.hash ||
  canonicalResource.toString() !== expectedResource.toString()
) {
  fail("protected-resource discovery returned unexpected metadata");
}
canonicalResource = canonicalResource.toString();

const expectedResourceMetadataUrl = new URL(
  "/.well-known/oauth-protected-resource/mcp",
  BASE_URL,
).toString();
const unauthenticatedResponse = await smokeFetch(`${BASE_URL}/mcp`, {
  method: "POST",
  redirect: "manual",
  headers: {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    "MCP-Protocol-Version": "2025-06-18",
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: "unauthenticated-boundary-check",
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "staging-boundary-check", version: "1" },
    },
  }),
});
const authenticate = unauthenticatedResponse.headers.get("www-authenticate");
await unauthenticatedResponse.body?.cancel();
if (
  unauthenticatedResponse.status !== 401 ||
  bearerResourceMetadata(authenticate) !== expectedResourceMetadataUrl
) {
  fail("unauthenticated MCP endpoint returned an invalid OAuth challenge");
}
log("unauthenticated MCP OAuth challenge ok");

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
  log("using supplied access token; skipping DCR, consent, and Entra login");
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
  log("token exchange ok");
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

let nextRequestId = 1;
function allocateRequestId() {
  const id = nextRequestId;
  nextRequestId += 1;
  return id;
}

function parseMcpResult(response, expectedId, resultSchema) {
  if (response.status !== 200) return null;
  const envelope = JSONRPCResultResponseSchema.safeParse(response.parsed);
  if (!envelope.success || envelope.data.id !== expectedId) return null;
  const result = resultSchema.safeParse(envelope.data.result);
  return result.success ? result.data : null;
}

const initializeId = allocateRequestId();
const init = await mcpCall(
  {
    jsonrpc: "2.0",
    id: initializeId,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "staging-live-smoke", version: "1.0.0" },
    },
  },
  null,
);
const initializeResult = parseMcpResult(
  init,
  initializeId,
  InitializeResultSchema,
);
if (
  !initializeResult ||
  initializeResult.protocolVersion !== "2025-06-18" ||
  !initializeResult.capabilities.tools
) {
  fail(`MCP initialize failed (${init.status})`);
}
log("MCP session established");

const initialized = await mcpCall(
  { jsonrpc: "2.0", method: "notifications/initialized" },
  init.sessionId,
);
if (initialized.status !== 200 && initialized.status !== 202) {
  fail(`MCP initialized notification failed (${initialized.status})`);
}

// Gate 0: tools/list must expose every expected tool. A tool that passes its
// own unit tests but is not registered looks identical to a nonexistent tool.
log("requesting tools/list ...");
const toolsListId = allocateRequestId();
const toolsListResp = await mcpCall(
  { jsonrpc: "2.0", id: toolsListId, method: "tools/list" },
  init.sessionId,
);
const toolsListResult = parseMcpResult(
  toolsListResp,
  toolsListId,
  ListToolsResultSchema,
);
if (!toolsListResult) {
  fail("tools/list failed");
}
const catalogError = validateStagingToolsListResult(toolsListResult);
if (catalogError) fail(catalogError);
log(
  `tools/list ok (${EXPECTED_TOOL_NAMES.length} registered; 38 model-visible, 1 app-only)`,
);

async function callTool(name, args) {
  const requestId = allocateRequestId();
  const result = await mcpCall(
    {
      jsonrpc: "2.0",
      id: requestId,
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
  const toolResult = parseMcpResult(result, requestId, CallToolResultSchema);
  if (!toolResult) {
    return { ok: false, reason: "invalid_mcp_response" };
  }
  const text = toolResult.content
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
  startDate: SCHEDULE_START_DATE,
  endDate: SCHEDULE_END_DATE,
});
const scheduleList = Array.isArray(schedule.data) ? schedule.data : [];
if (!schedule.ok || scheduleList.length === 0) {
  fail(`schedule.entries.byMember failed (${schedule.reason ?? "empty"})`);
}
log("schedule.entries.byMember ok");

// 13. Done. This smoke remains read-only and does not satisfy the remaining
// manual staging acceptance gates.
server.close();
if (process.env.SMOKE_ACCESS_TOKEN) {
  log(
    "PASS: supplied-token read-only staging subset passed (OAuth login and token issuance not tested).",
  );
} else {
  log("PASS: interactive OAuth and read-only staging subset passed.");
}
log("Manual staging acceptance checklist remains required.");
process.exit(0);
