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
 * Security: never prints access tokens, authorization codes, client
 * secrets, or state values. Only lengths and structural facts.
 *
 * Usage:
 *   node scripts/staging-live-smoke.mjs
 * Env:
 *   SMOKE_BASE_URL        (default: staging worker)
 *   SMOKE_EXPECT_MEMBER_ID (default: 149)
 *   SMOKE_BOARD_ID         (default: 32)
 *   SMOKE_NO_BROWSER       (skip `open`, print URL only)
 */

import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import process from "node:process";

const BASE_URL = (
  process.env.SMOKE_BASE_URL ??
  "https://connectwise-mcp-v2-staging.funcshun.workers.dev"
).replace(/\/+$/, "");
const EXPECT_MEMBER_ID = Number(process.env.SMOKE_EXPECT_MEMBER_ID ?? "149");
const BOARD_ID = Number(process.env.SMOKE_BOARD_ID ?? "32");
const LOGIN_TIMEOUT_MS = Number(process.env.SMOKE_LOGIN_TIMEOUT_MS ?? 420_000);

const log = (...parts) => console.log("[smoke]", ...parts);

function base64url(bytes) {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fail(message, detail) {
  log("FAIL", message);
  if (detail !== undefined) {
    try {
      log(
        "detail:",
        typeof detail === "string" ? detail : JSON.stringify(detail, null, 2),
      );
    } catch {
      log("detail:", String(detail));
    }
  }
  process.exit(1);
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

log(`base: ${BASE_URL}`);
log(`loopback callback: ${loopbackRedirectUri}`);

// 2. Canonical resource (for the `resource` parameter).
const resourceResponse = await fetch(
  `${BASE_URL}/.well-known/oauth-protected-resource`,
);
const resourceMeta = await resourceResponse.json().catch(() => ({}));
const canonicalResource =
  typeof resourceMeta?.resource === "string" ? resourceMeta.resource : BASE_URL;

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
  const registerResponse = await fetch(`${BASE_URL}/oauth/register`, {
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
    fail(
      `DCR rejected (${registerResponse.status})`,
      await registerResponse.text(),
    );
  }
  const registration = await registerResponse.json();
  if (!registration.client_id || !registration.client_secret) {
    fail("DCR response missing client_id/client_secret", registration);
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
  if (process.env.SMOKE_NO_BROWSER) {
    log(`Open this URL in a browser: ${authorizeUrl}`);
  } else {
    const opener = spawn("open", [authorizeUrl.toString()], {
      stdio: "ignore",
    });
    opener.on("error", () =>
      log(`Open this URL in a browser: ${authorizeUrl}`),
    );
    // Bring the default browser to the foreground so the consent page is visible.
    spawn("osascript", ["-e", 'tell application "Brave Browser" to activate'], {
      stdio: "ignore",
    }).on("error", () => {});
  }

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
    return fetch(`${BASE_URL}/oauth/token`, {
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
    const firstBody = await tokenResponse.text();
    tokenResponse = await tokenRequest({});
    if (!tokenResponse.ok) {
      fail(
        `token exchange failed (${tokenResponse.status})`,
        firstBody.length < 500 ? firstBody : `${tokenResponse.status}`,
      );
    }
  }
  token = await tokenResponse.json();
  if (!token.access_token) {
    fail("token response missing access_token", {
      error: token.error,
      error_description: token.error_description,
    });
  }
  log(
    `token ok (length ${token.access_token.length}, scopes: ${(token.scope ?? "").split(" ").join(",")})`,
  );
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
  const response = await fetch(`${BASE_URL}/mcp`, {
    method: "POST",
    headers: mcpHeaders(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
    body: JSON.stringify(payload),
  });
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();
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
    raw: text,
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
  fail(`MCP initialize failed (${init.status})`, init.raw.slice(0, 400));
}
log(`MCP session established (server: ${init.parsed.result.serverInfo?.name})`);

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
  fail("tools/list failed", toolsListResp.raw);
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
  fail(
    `tools/list is missing ${missing.length} expected tool(s): ${missing.join(", ")}`,
    `registered (${registeredTools.length}): ${registeredTools.join(", ")}`,
  );
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
  fail(`tools/list exposes unexpected tool(s): ${unexpected.join(", ")}`);
}
log(
  `tools/list ok (${registeredTools.length} registered; all ${expectedTools.length} expected present; no forbidden generic tools): ${registeredTools.join(", ")}`,
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
      detail: `HTTP ${result.status}: ${result.raw.slice(0, 400)}`,
    };
  }
  const payload = result.parsed;
  if (payload?.error) {
    return { ok: false, detail: payload.error };
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
    text,
    data,
    detail: toolResult?.isError
      ? (text ?? JSON.stringify(toolResult))
      : undefined,
  };
}

// 10. Gate 1: get_my_member.
log("calling get_my_member ...");
const member = await callTool("get_my_member", {});
if (!member.ok) {
  fail("get_my_member failed", member.detail);
}
const memberId = member.data?.member?.id ?? member.data?.id;
log(
  `myMember ok (id=${memberId}, name=${member.data?.member?.firstName} ${member.data?.member?.lastName ?? ""})`.trim(),
);
if (memberId !== EXPECT_MEMBER_ID) {
  fail(
    `get_my_member returned id ${memberId}, expected ${EXPECT_MEMBER_ID}`,
    member.text,
  );
}

// 11. Gate 2: board statuses via the catalog tool.
log(
  `calling call_connectwise service.boards.statuses (boardId ${BOARD_ID}) ...`,
);
const statuses = await callTool("call_connectwise", {
  route: "service.boards.statuses",
  boardId: BOARD_ID,
});
if (!statuses.ok) {
  fail("call_connectwise service.boards.statuses failed", statuses.detail);
}
const statusList = Array.isArray(statuses.data)
  ? statuses.data
  : statuses.data?.items;
if (!Array.isArray(statusList) || statusList.length === 0) {
  fail(
    "board statuses came back empty",
    statuses.text?.slice(0, 400) ?? "no data",
  );
}
log(`board ${BOARD_ID} statuses ok (${statusList.length} statuses)`);

// 12. Gate 3: fixed-route schedule catalog date range.
log("calling call_connectwise schedule.entries.byMember (date range) ...");
const schedule = await callTool("call_connectwise", {
  route: "schedule.entries.byMember",
  memberId: EXPECT_MEMBER_ID,
  startDate: "2026-08-31",
  endDate: "2026-09-06",
});
const scheduleList = Array.isArray(schedule.data)
  ? schedule.data
  : (schedule.data?.slice?.(0) ?? []);
if (!schedule.ok || scheduleList.length === 0) {
  fail(
    "schedule.entries.byMember failed (InvalidOrderBy?)",
    schedule.detail ?? schedule.text,
  );
}
log(`schedule.entries.byMember ok (${scheduleList.length} entries)`);

// 13. Done. The smoke remains read-only; write acceptance requires a separately
// authorized staging procedure and an access token carrying mcp:write.
server.close();
log("PASS: staging worker is fully operational (auth + ConnectWise data).");
process.exit(0);
