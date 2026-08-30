import type { ConnectWiseCredentials } from "./connectwise-profile";

const MAX_RESPONSE_BYTES = 1_000_000;

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Best-effort cleanup only; callers receive the sanitized primary error.
  }
}

async function cancelReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // Best-effort cleanup only; callers receive the sanitized primary error.
  }
}

async function readBoundedResponse(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await cancelResponseBody(response);
    throw new Error("ConnectWise response too large");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await cancelReader(reader);
      throw new Error("ConnectWise response too large");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

export type ConnectWiseClientDependencies = {
  fetcher?: typeof fetch;
  timeoutMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  log?: (message: string) => void;
};

export type ConnectWiseClient = {
  getServiceTicket(ticketId: number): Promise<unknown>;
  getTicketNotes(ticketId: number, pageSize: number): Promise<unknown>;
  getTicketAttachments(ticketId: number, pageSize: number): Promise<unknown>;
  getTicketTasks(ticketId: number, pageSize: number): Promise<unknown>;
  getTicketTimeEntries(ticketId: number, pageSize: number): Promise<unknown>;
  createTicketNote(
    ticketId: number,
    input: {
      text: string;
      internalOnly: boolean;
      resolutionNote: boolean;
      issueNote: boolean;
    },
  ): Promise<unknown>;
  getServiceBoards(): Promise<unknown>;
  getBoardStatuses(boardId: number): Promise<unknown>;
  getBoardTypes(boardId: number): Promise<unknown>;
  listBoardTickets(boardId: number, pageSize: number): Promise<unknown>;
  getServiceStatuses(): Promise<unknown>;
  getServicePriorities(): Promise<unknown>;
  getServiceSources(): Promise<unknown>;
  getMyMember(): Promise<unknown>;
  listMembers(pageSize: number): Promise<unknown>;
  searchCompanies(query: string, pageSize: number): Promise<unknown>;
  searchContacts(query: string, pageSize: number): Promise<unknown>;
  listTimeEntries(pageSize: number): Promise<unknown>;
  listScheduleEntries(pageSize: number): Promise<unknown>;
  getTimeSheets(pageSize: number): Promise<unknown>;
  getDocument(documentId: number): Promise<unknown>;
  downloadDocument(documentId: number): Promise<{
    base64: string;
    mimeType: string;
    byteLength: number;
  }>;
  catalogGet(
    route: string,
    params: Record<string, string | number>,
  ): Promise<unknown>;
  searchServiceTickets(searchText: string, pageSize: number): Promise<unknown>;
  getAgreement(agreementId: number): Promise<unknown>;
  getAgreementAdditions(
    agreementId: number,
    pageSize: number,
  ): Promise<unknown>;
  createAgreementAddition(
    agreementId: number,
    input: {
      productId: number;
      quantity: number;
      unitPrice: number;
      effectiveDate: string;
      description?: string;
      billableOption: "Billable" | "DoNotBill" | "NoCharge";
    },
  ): Promise<unknown>;
  getRecentAgreementInvoices(
    agreementId: number,
    pageSize: number,
  ): Promise<unknown>;
};

export type ConnectWiseRequestDiagnostics = {
  method: string;
  path: string;
  bodyPreview?: string;
};

export class ConnectWiseRequestError extends Error {
  constructor(
    readonly status: number,
    readonly diagnostics?: ConnectWiseRequestDiagnostics,
  ) {
    super(
      `ConnectWise request failed (${status})${diagnostics ? ` at ${diagnostics.method} ${diagnostics.path}` : ""}${diagnostics?.bodyPreview ? `: ${diagnostics.bodyPreview}` : ""}`,
    );
    this.name = "ConnectWiseRequestError";
  }
}

const SECRET_KEY_PATTERN = [
  "authorization",
  "client_secret",
  "clientSecret",
  "private_key",
  "privateKey",
  "api_key",
  "apiKey",
  "access_token",
  "accessToken",
  "refresh_token",
  "credential",
  "password",
  "token",
].join("|");

function scrubSecrets(value: string): string {
  return value
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, "$1 [REDACTED]")
    .replace(
      new RegExp(
        `["']?(?:${SECRET_KEY_PATTERN})["']?\\s*[:=]\\s*["']?[A-Za-z0-9._~+/=-]{8,}`,
        "g",
      ),
      "[REDACTED]",
    );
}

async function readErrorBodyPreview(
  response: Response,
  timeoutMs: number = 1_000,
): Promise<string | undefined> {
  try {
    if (!response.body) return undefined;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const remainingMs = Math.max(1, deadline - Date.now());
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race<ReadableStreamReadResult<Uint8Array>>([
        reader.read(),
        new Promise((resolve) => {
          timer = setTimeout(
            () => resolve({ done: true, value: undefined }),
            remainingMs,
          );
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (result.done) break;
      text += decoder.decode(result.value, { stream: true });
      if (text.length >= 600) break;
    }
    await cancelReader(reader);
    const cleaned = scrubSecrets(
      text.replace(/[\u0000-\u001F\u007F]/g, " ").trim(),
    );
    return cleaned.length > 0 ? cleaned.slice(0, 500) : undefined;
  } catch {
    return undefined;
  }
}

export class ConnectWiseDownloadError extends Error {
  constructor(readonly status: number) {
    super(`ConnectWise download failed (${status})`);
    this.name = "ConnectWiseDownloadError";
  }
}

const MAX_DOWNLOAD_BYTES = 8_000_000;

async function readBoundedBytes(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await cancelResponseBody(response);
    throw new Error("ConnectWise download too large");
  }
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await cancelReader(reader);
      throw new Error("ConnectWise download too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

type CatalogRoute = {
  path: (params: Record<string, string | number>) => string;
  query?: (
    params: Record<string, string | number>,
  ) => Record<string, string | number>;
  required: (string | number)[];
  transform?: (value: unknown) => unknown;
};

// CW rejects orderBy on schedule entries, so order them in the worker.
function sortByDateStart(value: unknown): unknown {
  if (!Array.isArray(value) || value.length === 0) return value;
  const items = value as Array<Record<string, unknown>>;
  if (!items.every((entry) => entry && typeof entry.dateStart === "string")) {
    return value;
  }
  return [...items].sort((a, b) =>
    String(a.dateStart).localeCompare(String(b.dateStart)),
  );
}

const CATALOG_DOCUMENT_RECORD_TYPES = new Set([
  "Ticket",
  "Project",
  "Agreement",
  "Company",
  "Contact",
  "Vendor",
]);

export const CATALOG_ROUTE_IDS = [
  "service.boards.statuses",
  "service.boards.types",
  "service.tickets.byStatus",
  "service.tickets.byOwner",
  "company.configurations",
  "system.documents",
  "finance.agreements.byName",
  "time.entries.byMember",
  "schedule.entries.byMember",
] as const;

export type CatalogRouteId = (typeof CATALOG_ROUTE_IDS)[number];

const CATALOG_ROUTES: Record<CatalogRouteId, CatalogRoute> = {
  "service.boards.statuses": {
    path: (p) => `/service/boards/${p.boardId}/statuses`,
    required: ["boardId"],
  },
  "service.boards.types": {
    path: (p) => `/service/boards/${p.boardId}/types`,
    required: ["boardId"],
  },
  "service.tickets.byStatus": {
    path: () => "/service/tickets",
    query: (p) => ({
      conditions: `status/id=${p.statusId}`,
      pageSize: p.pageSize ?? 20,
    }),
    required: ["statusId"],
  },
  "service.tickets.byOwner": {
    path: () => "/service/tickets",
    query: (p) => ({
      conditions: `owner/id=${p.memberId}`,
      orderBy: "dateEntered desc",
      pageSize: p.pageSize ?? 20,
    }),
    required: ["memberId"],
  },
  "company.configurations": {
    path: () => "/company/configurations",
    query: (p) => ({
      ...(p.query
        ? { conditions: `name like '%${conditionString(String(p.query))}%'` }
        : {}),
      pageSize: p.pageSize ?? 20,
    }),
    required: [],
  },
  "system.documents": {
    path: () => "/system/documents",
    query: (p) => ({
      recordType: p.recordType ?? "Ticket",
      recordId: Number(p.recordId),
      pageSize: p.pageSize ?? 20,
    }),
    required: ["recordId"],
  },
  "finance.agreements.byName": {
    path: () => "/finance/agreements",
    query: (p) => ({
      conditions: `name like '%${conditionString(String(p.name))}%'`,
      pageSize: p.pageSize ?? 20,
    }),
    required: ["name"],
  },
  "time.entries.byMember": {
    path: () => "/time/entries",
    query: (p) => ({
      conditions: `member/id=${p.memberId}`,
      pageSize: p.pageSize ?? 20,
    }),
    required: ["memberId"],
  },
  "schedule.entries.byMember": {
    path: () => "/schedule/entries",
    query: (p) => ({
      conditions: [
        `member/id=${p.memberId}`,
        ...scheduleDateConditions(p),
      ].join(" and "),
      pageSize: p.pageSize ?? 20,
    }),
    required: ["memberId"],
    transform: sortByDateStart,
  },
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isoDateToUtcMs(value: string): number {
  const [year, month, day] = value.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error("Invalid date (expected YYYY-MM-DD)");
  }
  return Date.UTC(year, month - 1, day);
}

function scheduleDateConditions(
  p: Readonly<Record<string, unknown>>,
): string[] {
  const clauses: string[] = [];
  for (const [key, operator] of [
    ["startDate", ">="],
    ["endDate", "<="],
  ] as const) {
    const value = p[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || !ISO_DATE.test(value)) {
      throw new Error(`Invalid ${key} (expected YYYY-MM-DD)`);
    }
    // CW requires the dateStart field and square-bracket datetime literals.
    clauses.push(
      `dateStart ${operator} [${value}${operator === "<=" ? "T23:59:59" : ""}]`,
    );
  }
  if (clauses.length === 2) {
    const startMs = isoDateToUtcMs(String(p.startDate));
    const endMs = isoDateToUtcMs(String(p.endDate));
    if (endMs < startMs) {
      throw new Error("endDate must be on or after startDate");
    }
    if (endMs - startMs > 31 * 86_400_000) {
      throw new Error("Date range must be 31 days or less");
    }
  }
  return clauses;
}

function positiveId(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid ${label}`);
  }
}

function boundedPageSize(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 50) {
    throw new Error("Invalid page size");
  }
}

function conditionString(value: string): string {
  if (
    value.length < 1 ||
    value.length > 100 ||
    /[\u0000-\u001F\u007F]/.test(value)
  ) {
    throw new Error("Invalid search text");
  }
  return value.replaceAll("'", "''");
}

export function createConnectWiseClient(
  credentials: ConnectWiseCredentials,
  dependencies: ConnectWiseClientDependencies = {},
): ConnectWiseClient {
  const fetcher = dependencies.fetcher ?? fetch;
  const sleep =
    dependencies.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const log = dependencies.log ?? (() => {});
  const timeoutMs = dependencies.timeoutMs ?? 8_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new Error("Invalid ConnectWise timeout configuration");
  }
  const authorization = btoa(
    `${credentials.companyId}+${credentials.publicKey}:${credentials.privateKey}`,
  );

  async function requestJson(
    method: "GET" | "POST",
    path: string,
    query?: Readonly<Record<string, string | number>>,
    body?: unknown,
  ): Promise<unknown> {
    const url = new URL(`${credentials.apiBaseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      url.searchParams.set(key, String(value));
    }
    const maxAttempts = method === "GET" ? 2 : 1;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      let response: Response;
      const startedAtMs = Date.now();
      try {
        response = await fetcher(url, {
          method,
          // Workers only supports "follow" | "manual"; "error" throws
          // synchronously there, so redirects are refused explicitly below.
          redirect: "manual",
          headers: {
            Accept: "application/json",
            Authorization: `Basic ${authorization}`,
            clientId: credentials.clientId,
            ...(body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        if (attempt + 1 < maxAttempts) {
          log(
            JSON.stringify({
              event: "cw_request",
              method,
              url: url.toString(),
              status: null,
              latencyMs: Date.now() - startedAtMs,
              failure: "unavailable",
            }),
          );
          await sleep(100);
          continue;
        }
        log(
          JSON.stringify({
            event: "cw_request",
            method,
            url: url.toString(),
            status: null,
            latencyMs: Date.now() - startedAtMs,
            failure: "unavailable",
          }),
        );
        throw new Error("ConnectWise request unavailable");
      }
      if (response.status >= 300 && response.status < 400) {
        await cancelResponseBody(response);
        log(
          JSON.stringify({
            event: "cw_request",
            method,
            url: url.toString(),
            status: response.status,
            latencyMs: Date.now() - startedAtMs,
            failure: "redirect_refused",
          }),
        );
        throw new Error(
          `ConnectWise redirected the request (${response.status}); redirects are not followed`,
        );
      }
      if (
        method === "GET" &&
        [429, 502, 503, 504].includes(response.status) &&
        attempt + 1 < maxAttempts
      ) {
        await cancelResponseBody(response);
        await sleep(100);
        continue;
      }
      if (!response.ok) {
        const bodyPreview = await readErrorBodyPreview(response);
        log(
          JSON.stringify({
            event: "cw_request",
            method,
            url: url.toString(),
            status: response.status,
            latencyMs: Date.now() - startedAtMs,
            ...(bodyPreview ? { bodyPreview } : {}),
          }),
        );
        throw new ConnectWiseRequestError(response.status, {
          method,
          path,
          ...(bodyPreview ? { bodyPreview } : {}),
        });
      }
      log(
        JSON.stringify({
          event: "cw_request",
          method,
          url: url.toString(),
          status: response.status,
          latencyMs: Date.now() - startedAtMs,
        }),
      );
      const responseText = await readBoundedResponse(response);
      if (!responseText) return null;
      try {
        return JSON.parse(responseText) as unknown;
      } catch {
        throw new Error("Invalid ConnectWise response");
      }
    }
    throw new Error("ConnectWise request unavailable");
  }

  return {
    async getServiceTicket(ticketId: number): Promise<unknown> {
      positiveId(ticketId, "service ticket ID");
      return requestJson("GET", `/service/tickets/${ticketId}`);
    },

    async getTicketNotes(ticketId: number, pageSize: number): Promise<unknown> {
      positiveId(ticketId, "service ticket ID");
      boundedPageSize(pageSize);
      try {
        return await requestJson("GET", `/service/tickets/${ticketId}/notes`, {
          pageSize,
          orderBy: "dateCreated asc",
        });
      } catch (error) {
        if (
          !(error instanceof ConnectWiseRequestError) ||
          error.status !== 404
        ) {
          throw error;
        }
        return requestJson("GET", `/project/tickets/${ticketId}/notes`, {
          pageSize,
          orderBy: "dateCreated asc",
        });
      }
    },

    async getTicketAttachments(
      ticketId: number,
      pageSize: number,
    ): Promise<unknown> {
      positiveId(ticketId, "service ticket ID");
      boundedPageSize(pageSize);
      return requestJson("GET", "/system/documents", {
        recordType: "Ticket",
        recordId: ticketId,
        pageSize,
      });
    },

    async getTicketTasks(ticketId: number, pageSize: number): Promise<unknown> {
      positiveId(ticketId, "service ticket ID");
      boundedPageSize(pageSize);
      return requestJson("GET", `/service/tickets/${ticketId}/tasks`, {
        pageSize,
      });
    },

    async getTicketTimeEntries(
      ticketId: number,
      pageSize: number,
    ): Promise<unknown> {
      positiveId(ticketId, "service ticket ID");
      boundedPageSize(pageSize);
      return requestJson("GET", "/time/entries", {
        conditions: `(chargeToType='ServiceTicket' OR chargeToType='ProjectTicket') AND chargeToId=${ticketId}`,
        pageSize,
        orderBy: "dateEntered desc",
      });
    },

    async createTicketNote(ticketId, input): Promise<unknown> {
      positiveId(ticketId, "service ticket ID");
      const payload = {
        text: input.text,
        internalAnalysisFlag: input.internalOnly,
        externalFlag: !input.internalOnly,
        resolutionFlag: input.resolutionNote,
        issueFlag: input.issueNote,
        detailDescriptionFlag: false,
      };
      try {
        return await requestJson(
          "POST",
          `/service/tickets/${ticketId}/notes`,
          undefined,
          payload,
        );
      } catch (error) {
        if (
          !(error instanceof ConnectWiseRequestError) ||
          error.status !== 404
        ) {
          throw error;
        }
        return requestJson(
          "POST",
          `/project/tickets/${ticketId}/notes`,
          undefined,
          payload,
        );
      }
    },

    async getServiceBoards(): Promise<unknown> {
      return requestJson("GET", "/service/boards", {
        orderBy: "name asc",
        pageSize: 50,
      });
    },

    async getBoardStatuses(boardId: number): Promise<unknown> {
      positiveId(boardId, "board ID");
      return requestJson("GET", `/service/boards/${boardId}/statuses`);
    },

    async getBoardTypes(boardId: number): Promise<unknown> {
      positiveId(boardId, "board ID");
      return requestJson("GET", `/service/boards/${boardId}/types`);
    },

    async listBoardTickets(
      boardId: number,
      pageSize: number,
    ): Promise<unknown> {
      positiveId(boardId, "board ID");
      boundedPageSize(pageSize);
      return requestJson("GET", "/service/tickets", {
        conditions: `board/id=${boardId}`,
        orderBy: "dateEntered desc",
        pageSize,
      });
    },

    async getServiceStatuses(): Promise<unknown> {
      return requestJson("GET", "/service/statuses", {
        orderBy: "name asc",
        pageSize: 50,
      });
    },

    async getServicePriorities(): Promise<unknown> {
      return requestJson("GET", "/service/priorities", {
        orderBy: "name asc",
        pageSize: 50,
      });
    },

    async getServiceSources(): Promise<unknown> {
      return requestJson("GET", "/service/sources", {
        orderBy: "name asc",
        pageSize: 50,
      });
    },

    async getMyMember(): Promise<unknown> {
      const memberId = credentials.memberId;
      if (memberId === undefined) {
        throw new Error(
          "ConnectWise profile is missing memberId; add it to enable get_my_member",
        );
      }
      return requestJson("GET", `/system/members/${memberId}`);
    },

    async listMembers(pageSize: number): Promise<unknown> {
      boundedPageSize(pageSize);
      return requestJson("GET", "/system/members", {
        orderBy: "name asc",
        pageSize,
      });
    },

    async searchCompanies(query: string, pageSize: number): Promise<unknown> {
      boundedPageSize(pageSize);
      const escaped = conditionString(query);
      return requestJson("GET", "/company/companies", {
        conditions: `name like '%${escaped}%'`,
        orderBy: "name asc",
        pageSize,
      });
    },

    async searchContacts(query: string, pageSize: number): Promise<unknown> {
      boundedPageSize(pageSize);
      const escaped = conditionString(query);
      return requestJson("GET", "/company/contacts", {
        conditions: `(name like '%${escaped}%' OR email like '%${escaped}%')`,
        orderBy: "name asc",
        pageSize,
      });
    },

    async listTimeEntries(pageSize: number): Promise<unknown> {
      boundedPageSize(pageSize);
      return requestJson("GET", "/time/entries", {
        orderBy: "dateEntered desc",
        pageSize,
      });
    },

    async listScheduleEntries(pageSize: number): Promise<unknown> {
      boundedPageSize(pageSize);
      // CW rejects orderBy on /schedule/entries; order in the caller if needed.
      return requestJson("GET", "/schedule/entries", { pageSize });
    },

    async getTimeSheets(pageSize: number): Promise<unknown> {
      boundedPageSize(pageSize);
      return requestJson("GET", "/time/sheets", {
        orderBy: "dateCreated desc",
        pageSize,
      });
    },

    async getDocument(documentId: number): Promise<unknown> {
      positiveId(documentId, "document ID");
      return requestJson("GET", `/system/documents/${documentId}`);
    },

    async downloadDocument(
      documentId: number,
    ): Promise<{ base64: string; mimeType: string; byteLength: number }> {
      positiveId(documentId, "document ID");
      const url = new URL(
        `${credentials.apiBaseUrl}/system/documents/${documentId}/download`,
      );
      let response: Response;
      try {
        response = await fetcher(url, {
          method: "GET",
          redirect: "manual",
          headers: {
            Accept: "application/octet-stream",
            Authorization: `Basic ${authorization}`,
            clientId: credentials.clientId,
          },
          signal: AbortSignal.timeout(30_000),
        });
      } catch {
        throw new Error("ConnectWise request unavailable");
      }
      if (response.status >= 300 && response.status < 400) {
        await cancelResponseBody(response);
        throw new Error(
          `ConnectWise redirected the download (${response.status}); redirects are not followed`,
        );
      }
      if (!response.ok) {
        await cancelResponseBody(response);
        throw new ConnectWiseDownloadError(response.status);
      }
      const bytes = await readBoundedBytes(response, MAX_DOWNLOAD_BYTES);
      const contentType = response.headers.get("Content-Type") ?? "";
      const mimeType =
        contentType.split(";")[0]?.trim() || "application/octet-stream";
      return {
        base64: bytesToBase64(bytes),
        mimeType,
        byteLength: bytes.byteLength,
      };
    },

    async catalogGet(
      route: string,
      params: Record<string, string | number>,
    ): Promise<unknown> {
      const definition = CATALOG_ROUTES[route as CatalogRouteId];
      if (!definition) {
        throw new Error(`Unknown ConnectWise route: ${route}`);
      }
      for (const key of definition.required) {
        const value = params[key];
        if (typeof value === "number") {
          positiveId(value, `${key}`);
        } else if (typeof value !== "string" || value.length < 1) {
          throw new Error(`Missing ${key}`);
        }
      }
      if (
        params.recordType !== undefined &&
        !CATALOG_DOCUMENT_RECORD_TYPES.has(String(params.recordType))
      ) {
        throw new Error("Unsupported document record type");
      }
      if (params.pageSize !== undefined) {
        boundedPageSize(Number(params.pageSize));
      }
      for (const [key, value] of Object.entries(params)) {
        if (typeof value === "string" && /[\u0000-\u001F\u007F]/.test(value)) {
          throw new Error(`Invalid ${key}`);
        }
      }
      const path = definition.path(params);
      if (
        !/^\/[a-z0-9\-]+(\/[a-z0-9\-]+)*$/i.test(path) ||
        path.includes("//")
      ) {
        throw new Error("Invalid ConnectWise route");
      }
      const query = definition.query
        ? definition.query(params)
        : { pageSize: params.pageSize ?? 20 };
      const result = await requestJson("GET", path, query);
      return definition.transform ? definition.transform(result) : result;
    },

    async searchServiceTickets(
      searchText: string,
      pageSize: number,
    ): Promise<unknown> {
      boundedPageSize(pageSize);
      const escaped = conditionString(searchText);
      return requestJson("GET", "/service/tickets", {
        conditions: `summary contains '${escaped}'`,
        pageSize,
        orderBy: "dateEntered desc",
      });
    },

    async getAgreement(agreementId: number): Promise<unknown> {
      positiveId(agreementId, "agreement ID");
      return requestJson("GET", `/finance/agreements/${agreementId}`);
    },

    async getAgreementAdditions(
      agreementId: number,
      pageSize: number,
    ): Promise<unknown> {
      positiveId(agreementId, "agreement ID");
      boundedPageSize(pageSize);
      return requestJson(
        "GET",
        `/finance/agreements/${agreementId}/additions`,
        { pageSize },
      );
    },

    async createAgreementAddition(agreementId, input): Promise<unknown> {
      positiveId(agreementId, "agreement ID");
      positiveId(input.productId, "product ID");
      return requestJson(
        "POST",
        `/finance/agreements/${agreementId}/additions`,
        undefined,
        {
          product: { id: input.productId },
          quantity: input.quantity,
          unitPrice: input.unitPrice,
          effectiveDate: input.effectiveDate,
          billableOption: input.billableOption,
          ...(input.description ? { description: input.description } : {}),
        },
      );
    },

    async getRecentAgreementInvoices(
      agreementId: number,
      pageSize: number,
    ): Promise<unknown> {
      positiveId(agreementId, "agreement ID");
      boundedPageSize(pageSize);
      return requestJson("GET", "/finance/invoices", {
        conditions: `agreement/id=${agreementId}`,
        pageSize,
        orderBy: "date desc",
      });
    },
  };
}
