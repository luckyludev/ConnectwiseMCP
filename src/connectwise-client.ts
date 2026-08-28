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
