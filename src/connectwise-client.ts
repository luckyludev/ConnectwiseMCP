import type { ConnectWiseCredentials } from "./connectwise-profile";

const MAX_RESPONSE_BYTES = 1_000_000;
export const MAX_IMAGE_UPLOAD_BYTES = 1_000_000;
export const CONNECTWISE_IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const;

export type ConnectWiseImageMimeType =
  (typeof CONNECTWISE_IMAGE_MIME_TYPES)[number];
export type ConnectWiseDocumentRecordType = "Ticket" | "TimeEntry";

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

async function readBoundedResponse(
  response: Response,
  maxBytes: number = MAX_RESPONSE_BYTES,
  overflowMessage: string = "ConnectWise response too large",
): Promise<string> {
  const declaredLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await cancelResponseBody(response);
    throw new Error(overflowMessage);
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
    if (total > maxBytes) {
      await cancelReader(reader);
      throw new Error(overflowMessage);
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
  attachImageToTicket(
    ticketId: number,
    input: { filename: string; base64: string; mimeType: string },
  ): Promise<unknown>;
  attachImageToTimeEntry(
    timeEntryId: number,
    input: { filename: string; base64: string; mimeType: string },
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
  uploadImageDocument(
    recordType: ConnectWiseDocumentRecordType,
    recordId: number,
    input: {
      fileName: string;
      mimeType: ConnectWiseImageMimeType;
      base64: string;
      title?: string;
      privateFlag: boolean;
    },
  ): Promise<unknown>;
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
  createScheduleEntry(input: {
    memberId: number;
    dateStart: string;
    dateEnd: string;
    objectId?: number;
    objectType?: number;
    statusId?: number;
    allowConflicts?: boolean;
    doneFlag?: boolean;
    name?: string;
    whereId?: number;
  }): Promise<unknown>;
  updateScheduleEntry(
    entryId: number,
    input: {
      dateStart?: string;
      dateEnd?: string;
      statusId?: number;
      doneFlag?: boolean;
      name?: string;
      allowConflicts?: boolean;
      whereId?: number;
    },
  ): Promise<unknown>;
  deleteScheduleEntry(entryId: number): Promise<void>;
  openScheduleEntriesForObject(objectId: number): Promise<unknown[]>;
  createServiceTicket(input: {
    companyId: number;
    summary: string;
    boardId?: number;
    statusId?: number;
    contactId?: number;
    priorityId?: number;
    typeId?: number;
    ownerId?: number;
    initialDescription?: string;
  }): Promise<unknown>;
  updateServiceTicket(
    ticketId: number,
    input: {
      ownerId?: number;
      statusId?: number;
      boardId?: number;
      priorityId?: number;
      typeId?: number;
      summary?: string;
      contactId?: number;
    },
  ): Promise<unknown>;
  createTimeEntry(input: {
    memberId: number;
    timeStart: string;
    timeEnd: string;
    notes?: string;
    ticketId?: number;
    chargeToId?: number;
    workTypeId?: number;
    billableOption?: "Billable" | "DoNotBill" | "NoCharge";
  }): Promise<unknown>;
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

const IMAGE_FILE_EXTENSIONS: Record<
  ConnectWiseImageMimeType,
  readonly string[]
> = {
  "image/jpeg": [".jpg", ".jpeg"],
  "image/png": [".png"],
  "image/gif": [".gif"],
  "image/webp": [".webp"],
};

function isConnectWiseImageMimeType(
  value: string,
): value is ConnectWiseImageMimeType {
  return (CONNECTWISE_IMAGE_MIME_TYPES as readonly string[]).includes(value);
}

function imageFileName(
  value: string,
  mimeType: ConnectWiseImageMimeType,
): string {
  const trimmed = value.trim();
  if (
    trimmed.length < 1 ||
    trimmed.length > 128 ||
    /[\u0000-\u001F\u007F/\\]/.test(trimmed) ||
    !/^[A-Za-z0-9][A-Za-z0-9._ ()-]*$/.test(trimmed)
  ) {
    throw new Error("Invalid image file name");
  }
  const lower = trimmed.toLowerCase();
  if (!IMAGE_FILE_EXTENSIONS[mimeType].some((ext) => lower.endsWith(ext))) {
    throw new Error("Image file extension does not match MIME type");
  }
  return trimmed;
}

function imageTitle(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  const trimmed = value.trim();
  if (
    trimmed.length < 1 ||
    trimmed.length > 200 ||
    /[\u0000-\u001F\u007F]/.test(trimmed)
  ) {
    throw new Error("Invalid image title");
  }
  return trimmed;
}

function hasImageSignature(
  bytes: Uint8Array,
  mimeType: ConnectWiseImageMimeType,
): boolean {
  const startsWith = (...values: number[]) =>
    values.every((value, index) => bytes[index] === value);
  if (mimeType === "image/jpeg") {
    return startsWith(0xff, 0xd8, 0xff);
  }
  if (mimeType === "image/png") {
    return startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  }
  if (mimeType === "image/gif") {
    return (
      startsWith(0x47, 0x49, 0x46, 0x38, 0x37, 0x61) ||
      startsWith(0x47, 0x49, 0x46, 0x38, 0x39, 0x61)
    );
  }
  return (
    startsWith(0x52, 0x49, 0x46, 0x46) &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  );
}

function decodeImageBase64(
  value: string,
  mimeType: ConnectWiseImageMimeType,
): Uint8Array {
  const maxEncodedLength = 4 * Math.ceil(MAX_IMAGE_UPLOAD_BYTES / 3);
  if (
    value.length < 4 ||
    value.length > maxEncodedLength ||
    value.length % 4 !== 0 ||
    /\s/.test(value)
  ) {
    throw new Error("Invalid or oversized image data");
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new Error("Invalid image data");
  }
  if (binary.length < 1 || binary.length > MAX_IMAGE_UPLOAD_BYTES) {
    throw new Error("Invalid or oversized image data");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  if (bytesToBase64(bytes) !== value || !hasImageSignature(bytes, mimeType)) {
    throw new Error("Image data does not match the declared MIME type");
  }
  return bytes;
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
    // Filters on ticket OWNER (member/id) — not assigned resources.
    query: (p) => {
      if (
        p.includeClosed !== undefined &&
        p.includeClosed !== "true" &&
        p.includeClosed !== "false"
      ) {
        throw new Error("includeClosed must be 'true' or 'false'");
      }
      return {
        conditions: [
          `owner/id=${p.memberId}`,
          ...(p.includeClosed === "true" ? [] : ["closedFlag=false"]),
        ].join(" and "),
        fields:
          "id,summary,recordType,status,board,priority,severity,impact,owner,contact,site,company,closedFlag,closedBy,closedDate,dateResolved,type,source,slaStatus",
        pageSize: p.pageSize ?? 20,
      };
    },
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

const ATTACHMENT_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

const MAX_ATTACHMENT_BASE64_CHARS = Math.ceil((10_000_000 / 3) * 4);

function attachmentPayload(input: {
  filename: string;
  base64: string;
  mimeType: string;
}): { filename: string; fileContents: string; fileType: string } {
  if (!ATTACHMENT_MIME_TYPES.has(input.mimeType)) {
    throw new Error("Unsupported image type");
  }
  if (
    typeof input.base64 !== "string" ||
    input.base64.length === 0 ||
    input.base64.length > MAX_ATTACHMENT_BASE64_CHARS ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(input.base64)
  ) {
    throw new Error("Invalid image contents");
  }
  if (
    typeof input.filename !== "string" ||
    input.filename.length < 1 ||
    input.filename.length > 200 ||
    !/^[A-Za-z0-9][A-Za-z0-9 ._()\-]*\.[A-Za-z0-9]{1,10}$/.test(input.filename)
  ) {
    throw new Error("Invalid attachment filename");
  }
  return {
    filename: input.filename,
    fileContents: input.base64,
    fileType: input.mimeType,
  };
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

// CW stores schedule and time entries as UTC ISO strings. Accept ISO 8601
// WITH an explicit zone offset and convert to UTC; a bare local time or bare
// UTC lets timezone shifts slip in silently (Luis hit exactly this: a 06:30Z
// recurring meeting landing at 2:30 AM local).
const ISO_OFFSET_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)$/;

function toUtcIso(value: string, label: string): string {
  if (typeof value !== "string" || value.length < 10 || value.length > 40) {
    throw new Error(`Invalid ${label}`);
  }
  if (!ISO_OFFSET_RE.test(value)) {
    throw new Error(
      `${label} must be ISO 8601 with an explicit timezone offset (e.g. 2026-08-31T08:30:00-04:00)`,
    );
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new Error(`Invalid ${label}`);
  }
  // CW rejects fractional seconds on schedule/time entries; normalize to
  // second precision (new Date(ms).toISOString() yields .000Z).
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

// A board move auto-generates a zero-hour schedule entry on the moved ticket
// (hours is null, dateStart == dateEnd). Returns those entries so the caller
// can decide to delete them.
export function ghostScheduleEntries(
  entries: unknown[],
): Array<{ id: number; dateStart?: string; dateEnd?: string }> {
  return (Array.isArray(entries) ? entries : [])
    .filter(
      (entry): entry is Record<string, unknown> =>
        Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
    )
    .filter((entry) => {
      const hours = entry.hours;
      const zeroHours =
        hours === null || hours === undefined || Number(hours) === 0;
      if (!zeroHours) return false;
      // The spec's real ghost (246998) has dateStart == dateEnd. Some CW
      // board-move ghosts come back with null dates but zero hours, so catch
      // any zero-hour entry attached to the moved ticket.
      const dateStart =
        typeof entry.dateStart === "string" ? entry.dateStart : "";
      const dateEnd = typeof entry.dateEnd === "string" ? entry.dateEnd : "";
      return (
        (dateStart !== "" && dateStart === dateEnd) ||
        (dateStart === "" && dateEnd === "")
      );
    })
    .map((entry) => ({
      id: Number(entry.id),
      ...(typeof entry.dateStart === "string"
        ? { dateStart: entry.dateStart }
        : {}),
      ...(typeof entry.dateEnd === "string" ? { dateEnd: entry.dateEnd } : {}),
    }));
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

  function emitRequestLog(
    method: "GET" | "POST" | "PUT" | "DELETE",
    status: number | null,
    startedAtMs: number,
    outcome: "success" | "unavailable" | "redirect_refused" | "upstream_error",
  ): void {
    try {
      log(
        JSON.stringify({
          event: "cw_request",
          method,
          status,
          latencyMs: Math.min(
            30_000,
            Math.max(0, Math.round(Date.now() - startedAtMs)),
          ),
          outcome,
        }),
      );
    } catch {
      // Request diagnostics are best-effort and must not alter the result.
    }
  }

  async function requestJson(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    query?: Readonly<Record<string, string | number>>,
    body?: unknown,
    maxBodyBytes?: number,
    overflowMessage?: string,
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
          emitRequestLog(method, null, startedAtMs, "unavailable");
          await sleep(100);
          continue;
        }
        emitRequestLog(method, null, startedAtMs, "unavailable");
        throw new Error("ConnectWise request unavailable");
      }
      if (response.status >= 300 && response.status < 400) {
        await cancelResponseBody(response);
        emitRequestLog(
          method,
          response.status,
          startedAtMs,
          "redirect_refused",
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
        emitRequestLog(method, response.status, startedAtMs, "upstream_error");
        throw new ConnectWiseRequestError(response.status, {
          method,
          path,
          ...(bodyPreview ? { bodyPreview } : {}),
        });
      }
      emitRequestLog(method, response.status, startedAtMs, "success");
      const responseText = await readBoundedResponse(
        response,
        maxBodyBytes,
        overflowMessage,
      );
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

    async attachImageToTicket(ticketId, input): Promise<unknown> {
      positiveId(ticketId, "service ticket ID");
      const payload = attachmentPayload(input);
      try {
        return await requestJson(
          "POST",
          `/service/tickets/${ticketId}/attachments`,
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
          `/project/tickets/${ticketId}/attachments`,
          undefined,
          payload,
        );
      }
    },

    async attachImageToTimeEntry(timeEntryId, input): Promise<unknown> {
      positiveId(timeEntryId, "time entry ID");
      return requestJson(
        "POST",
        `/timeentries/${timeEntryId}/attachments`,
        undefined,
        attachmentPayload(input),
      );
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

    async uploadImageDocument(recordType, recordId, input): Promise<unknown> {
      positiveId(recordId, recordType + " record ID");
      if (recordType !== "Ticket" && recordType !== "TimeEntry") {
        throw new Error("Unsupported document record type");
      }
      if (!isConnectWiseImageMimeType(input.mimeType)) {
        throw new Error("Unsupported image MIME type");
      }
      const fileName = imageFileName(input.fileName, input.mimeType);
      const title = imageTitle(input.title, fileName);
      const bytes = decodeImageBase64(input.base64, input.mimeType);
      const body = new FormData();
      const fileBytes = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(fileBytes).set(bytes);
      body.append(
        "file",
        new Blob([fileBytes], { type: input.mimeType }),
        fileName,
      );
      body.append("recordId", String(recordId));
      body.append("recordType", recordType);
      body.append("title", title);
      body.append("privateFlag", String(input.privateFlag));

      const url = new URL(credentials.apiBaseUrl + "/system/documents");
      const startedAtMs = Date.now();
      let response: Response;
      try {
        response = await fetcher(url, {
          method: "POST",
          redirect: "manual",
          headers: {
            Accept: "application/json",
            Authorization: "Basic " + authorization,
            clientId: credentials.clientId,
          },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        emitRequestLog("POST", null, startedAtMs, "unavailable");
        throw new Error("ConnectWise request unavailable");
      }
      if (response.status >= 300 && response.status < 400) {
        await cancelResponseBody(response);
        emitRequestLog(
          "POST",
          response.status,
          startedAtMs,
          "redirect_refused",
        );
        throw new Error(
          "ConnectWise redirected the request (" +
            String(response.status) +
            "); redirects are not followed",
        );
      }
      if (!response.ok) {
        const bodyPreview = await readErrorBodyPreview(response);
        emitRequestLog("POST", response.status, startedAtMs, "upstream_error");
        throw new ConnectWiseRequestError(response.status, {
          method: "POST",
          path: "/system/documents",
          ...(bodyPreview ? { bodyPreview } : {}),
        });
      }
      emitRequestLog("POST", response.status, startedAtMs, "success");
      const responseText = await readBoundedResponse(response);
      if (!responseText) return null;
      try {
        return JSON.parse(responseText) as unknown;
      } catch {
        throw new Error("Invalid ConnectWise response");
      }
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

    async createServiceTicket(input): Promise<unknown> {
      positiveId(input.companyId, "company ID");
      const summary =
        typeof input.summary === "string" ? input.summary.trim() : "";
      if (summary.length < 1 || summary.length > 100) {
        throw new Error("summary is required (max 100 chars)");
      }
      const boardId = input.boardId ?? 32;
      const statusId = input.statusId ?? 547;
      const payload: Record<string, unknown> = {
        company: { id: input.companyId },
        summary,
        board: { id: boardId },
        status: { id: statusId },
      };
      if (input.contactId !== undefined) {
        positiveId(input.contactId, "contact ID");
        payload.contact = { id: input.contactId };
      }
      if (input.priorityId !== undefined) {
        positiveId(input.priorityId, "priority ID");
        payload.priority = { id: input.priorityId };
      }
      if (input.typeId !== undefined) {
        positiveId(input.typeId, "type ID");
        payload.type = { id: input.typeId };
      }
      if (input.ownerId !== undefined) {
        positiveId(input.ownerId, "owner ID");
        payload.owner = { id: input.ownerId };
      }
      const created = (await requestJson(
        "POST",
        "/service/tickets",
        undefined,
        payload,
      )) as Record<string, unknown>;
      if (input.initialDescription !== undefined) {
        const text = input.initialDescription.trim();
        if (text.length > 0 && typeof created.id === "number") {
          await requestJson(
            "POST",
            `/service/tickets/${created.id}/notes`,
            undefined,
            {
              text,
              detailDescriptionFlag: true,
              internalAnalysisFlag: false,
              resolutionFlag: false,
              issueFlag: false,
              externalFlag: true,
            },
          );
        }
      }
      return created;
    },

    async updateServiceTicket(ticketId, input): Promise<unknown> {
      positiveId(ticketId, "service ticket ID");
      // GET first, then merge and PUT: a blind PUT blanks every unpassed
      // field on established tickets. These are live client tickets.
      const existing = (await requestJson(
        "GET",
        `/service/tickets/${ticketId}`,
      )) as Record<string, unknown>;
      if (!existing || typeof existing !== "object") {
        throw new Error(`Service ticket ${ticketId} not found`);
      }
      const merged: Record<string, unknown> = { ...existing };
      // Drop read-only/system fields a PUT would reject.
      for (const field of [
        "id",
        "recordType",
        "_info",
        "dateEntered",
        "lastUpdated",
        "closedFlag",
        "closedDate",
        "dateResolved",
        "resolvedBy",
      ]) {
        delete merged[field];
      }
      if (input.ownerId !== undefined) {
        positiveId(input.ownerId, "owner ID");
        merged.owner = { id: input.ownerId };
      }
      if (input.statusId !== undefined) {
        positiveId(input.statusId, "status ID");
        merged.status = { id: input.statusId };
      }
      if (input.boardId !== undefined) {
        positiveId(input.boardId, "board ID");
        // Board moves auto-generate zero-hour ghost schedule entries; the
        // caller checks + cleans those up after the PUT.
        merged.board = { id: input.boardId };
      }
      if (input.priorityId !== undefined) {
        positiveId(input.priorityId, "priority ID");
        merged.priority = { id: input.priorityId };
      }
      if (input.typeId !== undefined) {
        positiveId(input.typeId, "type ID");
        merged.type = { id: input.typeId };
      }
      if (input.summary !== undefined) {
        const summary = input.summary.trim();
        if (summary.length < 1 || summary.length > 100) {
          throw new Error("summary must be 1-100 chars");
        }
        merged.summary = summary;
      }
      if (input.contactId !== undefined) {
        positiveId(input.contactId, "contact ID");
        merged.contact = { id: input.contactId };
      }
      return requestJson(
        "PUT",
        `/service/tickets/${ticketId}`,
        undefined,
        merged,
      );
    },

    async createScheduleEntry(input): Promise<unknown> {
      positiveId(input.memberId, "member ID");
      const dateStart = toUtcIso(input.dateStart, "dateStart");
      const dateEnd = toUtcIso(input.dateEnd, "dateEnd");
      const objectType = input.objectType ?? 4;
      if (input.objectId !== undefined) positiveId(input.objectId, "object ID");
      if (input.statusId !== undefined) {
        positiveId(input.statusId, "status ID");
      }
      if (objectType === 4 && input.objectId === undefined) {
        // CW requires objectId when the entry attaches to a service ticket.
        throw new Error(
          "objectId is required for a service schedule entry (objectType 4)",
        );
      }
      const payload: Record<string, unknown> = {
        member: { id: input.memberId },
        type: { id: objectType },
        status: { id: input.statusId ?? 1 },
        dateStart,
        dateEnd,
      };
      if (input.objectId !== undefined) payload.objectId = input.objectId;
      if (input.allowConflicts === true) {
        payload.allowScheduleConflictsFlag = true;
      }
      if (input.doneFlag === true) payload.doneFlag = true;
      if (input.name !== undefined && input.name.length > 0) {
        if (input.name.length > 500) throw new Error("name is too long");
        payload.name = input.name;
      }
      if (input.whereId !== undefined) {
        positiveId(input.whereId, "where ID");
        payload.where = { id: input.whereId };
      }
      return requestJson("POST", "/schedule/entries", undefined, payload);
    },

    async updateScheduleEntry(entryId, input): Promise<unknown> {
      positiveId(entryId, "schedule entry ID");
      // GET first, then merge and PUT: a blind PUT blanks every field that
      // is not passed on established records (Luis has hit this).
      const existing = (await requestJson(
        "GET",
        `/schedule/entries/${entryId}`,
      )) as Record<string, unknown>;
      if (!existing || typeof existing !== "object") {
        throw new Error(`Schedule entry ${entryId} not found`);
      }
      const merged: Record<string, unknown> = { ...existing };
      if (input.dateStart !== undefined) {
        merged.dateStart = toUtcIso(input.dateStart, "dateStart");
      }
      if (input.dateEnd !== undefined) {
        merged.dateEnd = toUtcIso(input.dateEnd, "dateEnd");
      }
      if (input.statusId !== undefined) {
        positiveId(input.statusId, "status ID");
        merged.status = { id: input.statusId };
      }
      if (input.doneFlag !== undefined) merged.doneFlag = input.doneFlag;
      if (input.name !== undefined) {
        if (input.name.length > 500) throw new Error("name is too long");
        merged.name = input.name;
      }
      if (input.allowConflicts === true) {
        merged.allowScheduleConflictsFlag = true;
      }
      if (input.whereId !== undefined) {
        positiveId(input.whereId, "where ID");
        merged.where = { id: input.whereId };
      }
      return requestJson(
        "PUT",
        `/schedule/entries/${entryId}`,
        undefined,
        merged,
      );
    },

    async deleteScheduleEntry(entryId): Promise<void> {
      positiveId(entryId, "schedule entry ID");
      await requestJson("DELETE", `/schedule/entries/${entryId}`);
    },

    async openScheduleEntriesForObject(objectId): Promise<unknown[]> {
      positiveId(objectId, "object ID");
      const found = (await requestJson("GET", "/schedule/entries", {
        conditions: `objectId=${objectId}`,
        pageSize: 50,
      })) as unknown[];
      return Array.isArray(found) ? found : [];
    },

    async createTimeEntry(input): Promise<unknown> {
      positiveId(input.memberId, "member ID");
      const timeStart = toUtcIso(input.timeStart, "timeStart");
      const timeEnd = toUtcIso(input.timeEnd, "timeEnd");
      if (input.ticketId !== undefined) positiveId(input.ticketId, "ticket ID");
      if (input.chargeToId !== undefined) {
        positiveId(input.chargeToId, "chargeTo ID");
      }
      if (input.workTypeId !== undefined) {
        positiveId(input.workTypeId, "workType ID");
      }
      if (input.notes !== undefined && input.notes.length > 2000) {
        throw new Error("notes are too long");
      }
      // Writing into a submitted timesheet fails server-side; fail fast with
      // a clear recall instruction instead of a generic CW error.
      const sheets = (await requestJson("GET", "/time/sheets", {
        conditions: `member/id=${input.memberId}`,
        pageSize: 5,
      })) as unknown[];
      if (Array.isArray(sheets)) {
        for (const sheet of sheets) {
          const status = (sheet as Record<string, unknown>)?.status;
          if (status === "PendingApproval") {
            throw new Error(
              "A timesheet is pending approval; time entries cannot be written until it is approved or recalled",
            );
          }
        }
      }
      const payload: Record<string, unknown> = {
        member: { id: input.memberId },
        timeStart,
        timeEnd,
        billableOption: input.billableOption ?? "Billable",
      };
      if (input.ticketId !== undefined) payload.ticket = { id: input.ticketId };
      if (input.chargeToId !== undefined) {
        payload.chargeToId = input.chargeToId;
      }
      if (input.workTypeId !== undefined)
        payload.workType = { id: input.workTypeId };
      if (input.notes !== undefined && input.notes.length > 0) {
        payload.notes = input.notes;
      }
      return requestJson("POST", "/time/entries", undefined, payload);
    },
  };
}
