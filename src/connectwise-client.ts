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

export class ConnectWiseRequestError extends Error {
  constructor(readonly status: number) {
    super(`ConnectWise request failed (${status})`);
    this.name = "ConnectWiseRequestError";
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
};

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
      orderBy: "dateEntered desc",
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
      orderBy: "name asc",
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
      orderBy: "name asc",
      pageSize: p.pageSize ?? 20,
    }),
    required: ["name"],
  },
  "time.entries.byMember": {
    path: () => "/time/entries",
    query: (p) => ({
      conditions: `member/id=${p.memberId}`,
      orderBy: "dateEntered desc",
      pageSize: p.pageSize ?? 20,
    }),
    required: ["memberId"],
  },
  "schedule.entries.byMember": {
    path: () => "/schedule/entries",
    query: (p) => ({
      conditions: `member/id=${p.memberId}`,
      orderBy: "start asc",
      pageSize: p.pageSize ?? 20,
    }),
    required: ["memberId"],
  },
};

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

export function createConnectWiseClient(
  credentials: ConnectWiseCredentials,
  dependencies: ConnectWiseClientDependencies = {},
): ConnectWiseClient {
  const fetcher = dependencies.fetcher ?? fetch;
  const sleep =
    dependencies.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
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
      try {
        response = await fetcher(url, {
          method,
          redirect: "error",
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
          await sleep(100);
          continue;
        }
        throw new Error("ConnectWise request unavailable");
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
        await cancelResponseBody(response);
        throw new ConnectWiseRequestError(response.status);
      }
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
      return requestJson("GET", "/system/myMember");
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
      return requestJson("GET", "/schedule/entries", {
        orderBy: "start asc",
        pageSize,
      });
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
          redirect: "error",
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
      return requestJson("GET", path, query);
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
