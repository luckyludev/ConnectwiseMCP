import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  MAX_SMOKE_RESPONSE_BYTES,
  readBoundedJson,
  readBoundedText,
} from "../scripts/smoke-response.mjs";

describe("staging smoke output safety", () => {
  it("reads bounded response bodies and parses JSON", async () => {
    const response = new Response(JSON.stringify({ ok: true }));
    await expect(readBoundedJson(response, {})).resolves.toEqual({ ok: true });
  });

  it("rejects and cancels declared or streamed oversized response bodies", async () => {
    let declaredCancelled = false;
    const declared = new Response(
      new ReadableStream({
        cancel() {
          declaredCancelled = true;
        },
      }),
      {
        headers: { "Content-Length": String(MAX_SMOKE_RESPONSE_BYTES + 1) },
      },
    );
    await expect(readBoundedText(declared)).rejects.toThrow(
      "response_too_large",
    );
    expect(declaredCancelled).toBe(true);

    const streamed = new Response("x".repeat(MAX_SMOKE_RESPONSE_BYTES + 1));
    await expect(readBoundedText(streamed)).rejects.toThrow(
      "response_too_large",
    );
  });

  it("fails no-browser runs before emitting configuration or OAuth data", () => {
    const canary = "CANARY_STATE_CLIENT_SECRET_MEMBER_DATA";
    const run = spawnSync(
      process.execPath,
      [new URL("../scripts/staging-live-smoke.mjs", import.meta.url).pathname],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          SMOKE_NO_BROWSER: "1",
          SMOKE_BASE_URL: `https://${canary}.invalid`,
          SMOKE_ACCESS_TOKEN: "",
        },
      },
    );
    const output = `${run.stdout}${run.stderr}`;
    expect(run.status).toBe(1);
    expect(output).toBe(
      "[smoke] FAIL browser launch disabled; provide an approved access token instead\n",
    );
    expect(output).not.toContain(canary);
  });

  it("rejects unsafe targets before transmitting a supplied token", async () => {
    const canary = "CANARY_BEARER_MUST_NOT_BE_SENT";
    let requests = 0;
    const mock = createServer((_request, response) => {
      requests += 1;
      response.end("{}");
    });
    await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${mock.address().port}`;

    const child = spawn(
      process.execPath,
      [new URL("../scripts/staging-live-smoke.mjs", import.meta.url).pathname],
      {
        env: {
          ...process.env,
          SMOKE_BASE_URL: baseUrl,
          SMOKE_EXPECT_RESOURCE: `${baseUrl}/mcp`,
          SMOKE_ALLOW_INSECURE_LOCALHOST: "",
          SMOKE_ACCESS_TOKEN: canary,
        },
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const exitCode = await new Promise((resolve) =>
      child.once("close", resolve),
    );
    await new Promise((resolve) => mock.close(resolve));

    expect(exitCode).toBe(1);
    expect(requests).toBe(0);
    expect(output).toBe(
      "[smoke] FAIL SMOKE_BASE_URL must be a canonical HTTPS origin\n",
    );
    expect(output).not.toContain(canary);
    expect(output).not.toContain(baseUrl);
  });

  it.each([
    ["https://example.invalid/path", "https://example.invalid/mcp"],
    ["https://user@example.invalid", "https://example.invalid/mcp"],
    ["https://example.invalid?query=1", "https://example.invalid/mcp"],
  ])("rejects a non-origin base URL (%s)", (baseUrl, expectedResource) => {
    const run = spawnSync(
      process.execPath,
      [new URL("../scripts/staging-live-smoke.mjs", import.meta.url).pathname],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          SMOKE_BASE_URL: baseUrl,
          SMOKE_EXPECT_RESOURCE: expectedResource,
          SMOKE_ACCESS_TOKEN: "CANARY_TOKEN",
        },
      },
    );
    expect(run.status).toBe(1);
    expect(`${run.stdout}${run.stderr}`).toBe(
      "[smoke] FAIL SMOKE_BASE_URL must be a canonical HTTPS origin\n",
    );
  });

  it("requires an independently configured resource for custom targets", () => {
    const run = spawnSync(
      process.execPath,
      [new URL("../scripts/staging-live-smoke.mjs", import.meta.url).pathname],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          SMOKE_BASE_URL: "https://staging.example.invalid",
          SMOKE_EXPECT_RESOURCE: "",
          SMOKE_ACCESS_TOKEN: "CANARY_TOKEN",
        },
      },
    );
    expect(run.status).toBe(1);
    expect(`${run.stdout}${run.stderr}`).toBe(
      "[smoke] FAIL SMOKE_EXPECT_RESOURCE is required with a non-default base URL\n",
    );
  });

  it.each([
    ["SMOKE_EXPECT_MEMBER_ID", "0", "must be a positive integer"],
    ["SMOKE_BOARD_ID", "1.5", "must be a positive integer"],
    ["SMOKE_LOGIN_TIMEOUT_MS", "999", "is outside the allowed range"],
  ])(
    "rejects invalid bounded numeric configuration for %s",
    (name, value, error) => {
      const run = spawnSync(
        process.execPath,
        [
          new URL("../scripts/staging-live-smoke.mjs", import.meta.url)
            .pathname,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            SMOKE_ACCESS_TOKEN: "CANARY_TOKEN",
            [name]: value,
          },
        },
      );
      expect(run.status).toBe(1);
      expect(`${run.stdout}${run.stderr}`).toBe(
        `[smoke] FAIL ${name} ${error}\n`,
      );
    },
  );

  it.each([
    [
      "2026-02-30",
      "2026-03-01",
      "SMOKE_SCHEDULE_START_DATE must be a valid YYYY-MM-DD date",
    ],
    [
      "2026-9-01",
      "2026-09-02",
      "SMOKE_SCHEDULE_START_DATE must be a valid YYYY-MM-DD date",
    ],
    [
      "2026-09-03",
      "2026-09-02",
      "SMOKE_SCHEDULE_END_DATE must not precede SMOKE_SCHEDULE_START_DATE",
    ],
    [
      "2026-09-01",
      "2026-09-08",
      "smoke schedule range must not exceed 7 days inclusive",
    ],
  ])(
    "rejects an unsafe schedule range (%s through %s)",
    (startDate, endDate, error) => {
      const run = spawnSync(
        process.execPath,
        [
          new URL("../scripts/staging-live-smoke.mjs", import.meta.url)
            .pathname,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            SMOKE_ACCESS_TOKEN: "CANARY_TOKEN",
            SMOKE_SCHEDULE_START_DATE: startDate,
            SMOKE_SCHEDULE_END_DATE: endDate,
          },
        },
      );
      expect(run.status).toBe(1);
      expect(`${run.stdout}${run.stderr}`).toBe(`[smoke] FAIL ${error}\n`);
    },
  );

  it("requires both approved schedule-range dates", () => {
    const run = spawnSync(
      process.execPath,
      [new URL("../scripts/staging-live-smoke.mjs", import.meta.url).pathname],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          SMOKE_ACCESS_TOKEN: "CANARY_TOKEN",
          SMOKE_SCHEDULE_START_DATE: "2026-09-01",
          SMOKE_SCHEDULE_END_DATE: "",
        },
      },
    );
    expect(run.status).toBe(1);
    expect(`${run.stdout}${run.stderr}`).toBe(
      "[smoke] FAIL SMOKE_SCHEDULE_START_DATE and SMOKE_SCHEDULE_END_DATE are required\n",
    );
  });

  it("keeps successful mocked live-flow output free of response data", async () => {
    const canary = "CANARY_SECRET_MEMBER_AND_CONNECTWISE_DATA";
    const smokePath = new URL(
      "../scripts/staging-live-smoke.mjs",
      import.meta.url,
    );
    const source = await readFile(smokePath, "utf8");
    const toolBlock = source.match(
      /const expectedTools = \[([\s\S]*?)\];/,
    )?.[1];
    const toolNames = [...(toolBlock ?? "").matchAll(/"([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(toolNames.length).toBe(38);

    let baseUrl = "";
    let capturedScheduleArguments;
    const mock = createServer(async (request, response) => {
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/.well-known/oauth-protected-resource") {
        response.end(JSON.stringify({ resource: `${baseUrl}/mcp` }));
        return;
      }

      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (payload.method === "initialize") {
        response.setHeader("Mcp-Session-Id", "safe-session");
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id,
            result: { serverInfo: { name: canary } },
          }),
        );
        return;
      }
      if (payload.method === "tools/list") {
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id,
            result: { tools: toolNames.map((name) => ({ name })) },
          }),
        );
        return;
      }
      if (payload.method === "tools/call") {
        let data;
        if (payload.params.name === "get_my_member") {
          data = { member: { id: 149, firstName: canary, lastName: canary } };
        } else if (
          payload.params.arguments.route === "service.boards.statuses"
        ) {
          data = [{ id: 1, name: canary }];
        } else {
          capturedScheduleArguments = payload.params.arguments;
          data = [{ id: 2, name: canary }];
        }
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id,
            result: { content: [{ type: "text", text: JSON.stringify(data) }] },
          }),
        );
        return;
      }
      response.end(JSON.stringify({ jsonrpc: "2.0", result: {} }));
    });
    await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${mock.address().port}`;

    const child = spawn(process.execPath, [smokePath.pathname], {
      env: {
        ...process.env,
        SMOKE_BASE_URL: baseUrl,
        SMOKE_EXPECT_RESOURCE: `${baseUrl}/mcp`,
        NODE_ENV: "test",
        SMOKE_ALLOW_INSECURE_LOCALHOST: "1",
        SMOKE_ACCESS_TOKEN: `TOKEN_${canary}`,
        SMOKE_SCHEDULE_START_DATE: "2026-09-01",
        SMOKE_SCHEDULE_END_DATE: "2026-09-07",
      },
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const exitCode = await new Promise((resolve) =>
      child.once("close", resolve),
    );
    await new Promise((resolve) => mock.close(resolve));

    expect(exitCode).toBe(0);
    expect(capturedScheduleArguments).toEqual({
      route: "schedule.entries.byMember",
      memberId: 149,
      startDate: "2026-09-01",
      endDate: "2026-09-07",
    });
    expect(output).toContain(
      "PASS: supplied-token read-only staging subset passed (OAuth login and token issuance not tested).",
    );
    expect(output).toContain(
      "using supplied access token; skipping DCR, consent, and Entra login",
    );
    expect(output).toContain(
      "Manual staging acceptance checklist remains required.",
    );
    expect(output).not.toContain("fully operational");
    expect(output).not.toContain(canary);
    expect(output).not.toContain(baseUrl);
    expect(output).not.toContain("safe-session");
  });

  it("keeps the mocked OAuth flow free of client and authorization values", async () => {
    const smokePath = new URL(
      "../scripts/staging-live-smoke.mjs",
      import.meta.url,
    );
    const source = await readFile(smokePath, "utf8");
    const toolBlock = source.match(
      /const expectedTools = \[([\s\S]*?)\];/,
    )?.[1];
    const toolNames = [...(toolBlock ?? "").matchAll(/"([^"]+)"/g)].map(
      (match) => match[1],
    );
    const canaries = {
      clientId: "CANARY_CLIENT_ID",
      clientSecret: "CANARY_CLIENT_SECRET",
      code: "CANARY_AUTHORIZATION_CODE",
      token: "CANARY_ACCESS_TOKEN",
      business: "CANARY_CONNECTWISE_DATA",
    };
    let capturedState = "";
    let baseUrl = "";

    const mock = createServer(async (request, response) => {
      response.setHeader("Content-Type", "application/json");
      const requestUrl = new URL(request.url, baseUrl);
      if (requestUrl.pathname === "/capture") {
        capturedState = requestUrl.searchParams.get("state") ?? "";
        response.end("{}");
        return;
      }
      if (requestUrl.pathname === "/.well-known/oauth-protected-resource") {
        response.end(JSON.stringify({ resource: `${baseUrl}/mcp` }));
        return;
      }
      if (requestUrl.pathname === "/oauth/register") {
        response.end(
          JSON.stringify({
            client_id: canaries.clientId,
            client_secret: canaries.clientSecret,
          }),
        );
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      if (requestUrl.pathname === "/oauth/token") {
        expect(request.headers.authorization).toContain(
          Buffer.from(`${canaries.clientId}:${canaries.clientSecret}`).toString(
            "base64",
          ),
        );
        expect(Buffer.concat(chunks).toString("utf8")).toContain(canaries.code);
        response.end(
          JSON.stringify({ access_token: canaries.token, scope: "mcp:read" }),
        );
        return;
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (payload.method === "initialize") {
        response.setHeader("Mcp-Session-Id", "oauth-session");
        response.end(
          JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: {} }),
        );
      } else if (payload.method === "tools/list") {
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id,
            result: { tools: toolNames.map((name) => ({ name })) },
          }),
        );
      } else if (payload.method === "tools/call") {
        const data =
          payload.params.name === "get_my_member"
            ? { member: { id: 149, firstName: canaries.business } }
            : [{ id: 1, name: canaries.business }];
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id,
            result: { content: [{ type: "text", text: JSON.stringify(data) }] },
          }),
        );
      } else {
        response.end(JSON.stringify({ jsonrpc: "2.0", result: {} }));
      }
    });
    await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${mock.address().port}`;

    const fakeBin = await mkdtemp(join(tmpdir(), "cw-smoke-open-"));
    const fakeOpen = join(fakeBin, "open");
    await writeFile(
      fakeOpen,
      `#!/usr/bin/env node
const url = new URL(process.argv[2]);
const state = url.searchParams.get("state");
await fetch(url.origin + "/capture?state=" + encodeURIComponent(state));
const callback = new URL(url.searchParams.get("redirect_uri"));
callback.searchParams.set("code", ${JSON.stringify(canaries.code)});
callback.searchParams.set("state", state);
await fetch(callback);
`,
    );
    await chmod(fakeOpen, 0o700);

    const child = spawn(process.execPath, [smokePath.pathname], {
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        SMOKE_BASE_URL: baseUrl,
        SMOKE_EXPECT_RESOURCE: `${baseUrl}/mcp`,
        NODE_ENV: "test",
        SMOKE_ALLOW_INSECURE_LOCALHOST: "1",
        SMOKE_ACCESS_TOKEN: "",
        SMOKE_LOGIN_TIMEOUT_MS: "5000",
        SMOKE_SCHEDULE_START_DATE: "2026-09-01",
        SMOKE_SCHEDULE_END_DATE: "2026-09-07",
      },
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const exitCode = await new Promise((resolve) =>
      child.once("close", resolve),
    );
    await new Promise((resolve) => mock.close(resolve));
    await rm(fakeBin, { recursive: true, force: true });

    expect(exitCode).toBe(0);
    expect(capturedState).not.toBe("");
    expect(output).toContain(
      "PASS: interactive OAuth and read-only staging subset passed.",
    );
    expect(output).toContain(
      "Manual staging acceptance checklist remains required.",
    );
    expect(output).not.toContain("OAuth login and token issuance not tested");
    expect(output).not.toContain("fully operational");
    expect(output).not.toContain("token ok (length");
    for (const value of [...Object.values(canaries), capturedState]) {
      expect(output).not.toContain(value);
    }
    expect(output).not.toContain(baseUrl);
  });

  it("does not contain response, authorization, or business-data log paths", async () => {
    const source = await readFile(
      new URL("../scripts/staging-live-smoke.mjs", import.meta.url),
      "utf8",
    );

    expect(source).not.toContain('log("detail:"');
    expect(source).not.toMatch(/log\([^\n]*authorizeUrl/);
    expect(source).not.toContain(".raw");
    expect(source).not.toContain("firstName");
    expect(source).not.toContain("lastName");
    expect(source).not.toContain("registration);");
    expect(source).not.toContain("payload.error");
    expect(source).not.toContain("statuses.text");
    expect(source).not.toContain("schedule.text");
    expect(source).not.toMatch(/statuses ok \(\$\{/);
    expect(source).not.toMatch(/entries ok \(\$\{/);
    expect(source).toContain(
      "const scheduleList = Array.isArray(schedule.data) ? schedule.data : [];",
    );
    expect(source).toContain("readBoundedText(response)");
  });
});
