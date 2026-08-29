import { type CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  CATALOG_ROUTE_IDS,
  ConnectWiseDownloadError,
  ConnectWiseRequestError,
  createConnectWiseClient,
  type ConnectWiseClient,
} from "./connectwise-client";
import {
  resolveConnectWiseCredentials,
  type ConnectWiseCredentials,
} from "./connectwise-profile";
import type { EntraAccessTokenProps } from "./auth-handler";
import {
  emitToolAudit,
  getAuditStartTime,
  type ToolAuditDependencies,
  type ToolAuditName,
} from "./audit";

type BusinessToolDependencies = {
  audit?: ToolAuditDependencies;
  createClient?: (credentials: ConnectWiseCredentials) => ConnectWiseClient;
  requestLog?: (message: string) => void;
};

type AuthProps = Partial<EntraAccessTokenProps> | undefined;

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown, max = 1_000): string | undefined {
  return typeof value === "string" ? value.slice(0, max) : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function boolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function id(value: unknown): number | undefined {
  const parsed = number(value);
  return parsed !== undefined && Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : undefined;
}

function reference(value: unknown): { id?: number; name?: string } | undefined {
  const parsed = object(value);
  if (!parsed) return undefined;
  const result: { id?: number; name?: string } = {};
  const parsedId = id(parsed.id);
  const parsedName = text(parsed.name, 200);
  if (parsedId !== undefined) result.id = parsedId;
  if (parsedName !== undefined) result.name = parsedName;
  return result.id === undefined && result.name === undefined
    ? undefined
    : result;
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

function list(value: unknown, max: number): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.slice(0, max).flatMap((entry) => {
        const parsed = object(entry);
        return parsed ? [parsed] : [];
      })
    : [];
}

function ticket(value: unknown): Record<string, unknown> {
  const parsed = object(value) ?? {};
  const info = object(parsed._info);
  return compact({
    id: id(parsed.id),
    summary: text(parsed.summary, 500),
    company: reference(parsed.company),
    board: reference(parsed.board),
    status: reference(parsed.status),
    priority: reference(parsed.priority),
    type: reference(parsed.type),
    owner: reference(parsed.owner),
    contact: reference(parsed.contact),
    created: text(info?.dateEntered, 100),
    updated: text(info?.lastUpdated, 100),
  });
}

function note(value: Record<string, unknown>): Record<string, unknown> {
  const internal =
    boolean(value.internalFlag) ?? boolean(value.internalAnalysisFlag) ?? false;
  return compact({
    id: id(value.id),
    text: text(value.text, 8_000),
    created: text(value.dateCreated, 100),
    createdBy: text(value.createdBy, 200),
    internal,
    external: boolean(value.externalFlag) ?? !internal,
    resolution: boolean(value.resolutionFlag),
    issue: boolean(value.issueFlag),
    detailDescription: boolean(value.detailDescriptionFlag),
    contact: reference(value.contact),
  });
}

function attachment(value: Record<string, unknown>): Record<string, unknown> {
  const info = object(value._info);
  return compact({
    id: id(value.id),
    title: text(value.title, 500),
    fileName: text(value.fileName, 500),
    size: number(value.size),
    documentType: reference(value.documentType),
    owner: text(value.owner, 200),
    created: text(value.createdOnDate, 100),
    updated: text(info?.lastUpdated, 100),
    public: boolean(value.publicFlag),
    readOnly: boolean(value.readOnlyFlag),
    link: boolean(value.linkFlag),
    image: boolean(value.imageFlag),
  });
}

function task(value: Record<string, unknown>): Record<string, unknown> {
  return compact({
    id: id(value.id),
    summary: text(value.summary, 1_000),
    priority: reference(value.priority),
    status: reference(value.status),
    dueDate: text(value.dueDate, 100),
    notes: text(value.notes, 4_000),
  });
}

function timeEntry(value: Record<string, unknown>): Record<string, unknown> {
  return compact({
    id: id(value.id),
    actualHours: number(value.actualHours),
    timeStart: text(value.timeStart, 100),
    member: reference(value.member),
    notes: text(value.notes, 4_000),
    workType: reference(value.workType),
  });
}

function agreement(value: unknown): Record<string, unknown> {
  const parsed = object(value) ?? {};
  return compact({
    id: id(parsed.id),
    name: text(parsed.name, 500),
    type: reference(parsed.type),
    company: reference(parsed.company),
    status: text(parsed.agreementStatus, 100),
    billingCycle: reference(parsed.billingCycle),
    billAmount: number(parsed.billAmount),
    nextInvoiceDate: text(parsed.nextInvoiceDate, 100),
  });
}

function addition(value: Record<string, unknown>): Record<string, unknown> {
  return compact({
    id: id(value.id),
    product: reference(value.product),
    quantity: number(value.quantity),
    unitPrice: number(value.unitPrice),
    extendedPrice: number(value.extendedPrice),
    cost: number(value.cost),
    effectiveDate: text(value.effectiveDate, 100),
    cancelledDate: text(value.cancelledDate, 100),
    billableOption: text(value.billableOption, 100),
    description: text(value.description, 1_000),
  });
}

function invoice(value: Record<string, unknown>): Record<string, unknown> {
  return compact({
    id: id(value.id),
    invoiceNumber: text(value.invoiceNumber, 200),
    total: number(value.total),
    date: text(value.date, 100),
  });
}

function additionsSummary(values: Record<string, unknown>[]) {
  const sanitized = values.map(addition);
  return {
    count: sanitized.length,
    totalExtendedPrice: sanitized.reduce(
      (sum, item) => sum + (number(item.extendedPrice) ?? 0),
      0,
    ),
    totalCost: sanitized.reduce(
      (sum, item) =>
        sum + (number(item.cost) ?? 0) * (number(item.quantity) ?? 0),
      0,
    ),
  };
}

function output(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function failureMessage(error: unknown): string {
  if (error instanceof ConnectWiseRequestError) {
    const diagnostics = error.diagnostics;
    const where = diagnostics
      ? ` at ${diagnostics.method} ${diagnostics.path}`
      : "";
    if (diagnostics?.bodyPreview) {
      return `ConnectWise request failed (${error.status})${where}: ${diagnostics.bodyPreview.slice(0, 300)}`;
    }
    if (error.status === 401 || error.status === 403) {
      return `ConnectWise denied this operation (${error.status})${where}`;
    }
    if (error.status === 404) return `ConnectWise record not found${where}`;
    return `ConnectWise request failed (${error.status})${where}`;
  }
  if (error instanceof ConnectWiseDownloadError) {
    return `ConnectWise download failed (${error.status})`;
  }
  if (
    error instanceof Error &&
    typeof error.message === "string" &&
    error.message.length > 0
  ) {
    return `ConnectWise operation failed: ${error.message.slice(0, 200)}`;
  }
  return "ConnectWise operation failed";
}

async function runBusinessTool(
  props: AuthProps,
  env: object,
  tool: ToolAuditName,
  operation: (client: ConnectWiseClient) => Promise<unknown>,
  dependencies: BusinessToolDependencies,
): Promise<CallToolResult> {
  const startedAtMs = getAuditStartTime(dependencies.audit);
  if (!props?.scopes?.includes("mcp:read")) {
    emitToolAudit(
      {
        props,
        tool,
        outcome: "denied",
        reason: "insufficient_scope",
        startedAtMs,
      },
      dependencies.audit,
    );
    return {
      isError: true,
      content: [{ type: "text", text: "Insufficient scope" }],
    };
  }
  if (!props.profileAlias) {
    emitToolAudit(
      {
        props,
        tool,
        outcome: "denied",
        reason: "profile_unavailable",
        startedAtMs,
      },
      dependencies.audit,
    );
    return {
      isError: true,
      content: [{ type: "text", text: "Authenticated profile unavailable" }],
    };
  }
  try {
    const requestLog = dependencies.requestLog ?? ((message: string) => {});
    const credentials = resolveConnectWiseCredentials(env, props.profileAlias);
    try {
      requestLog(
        JSON.stringify({
          event: "cw_credentials",
          profileAlias: props.profileAlias,
          companyIdLength: credentials.companyId.length,
          publicKeyLength: credentials.publicKey.length,
          privateKeyLength: credentials.privateKey.length,
          clientIdLength: credentials.clientId.length,
          apiBaseOrigin: new URL(credentials.apiBaseUrl).origin,
        }),
      );
    } catch {
      // Diagnostics are best-effort and must not alter the MCP result.
    }
    const clientFactory =
      dependencies.createClient ??
      ((c: ConnectWiseCredentials) =>
        createConnectWiseClient(c, { log: requestLog }));
    const client = clientFactory(credentials);
    const result = await operation(client);
    emitToolAudit(
      {
        props,
        tool,
        outcome: "success",
        reason: "ok",
        startedAtMs,
      },
      dependencies.audit,
    );
    return output(result);
  } catch (error) {
    emitToolAudit(
      {
        props,
        tool,
        outcome:
          error instanceof ConnectWiseRequestError &&
          (error.status === 401 || error.status === 403)
            ? "denied"
            : "failure",
        reason:
          error instanceof ConnectWiseRequestError &&
          (error.status === 401 || error.status === 403)
            ? "connectwise_denied"
            : "operation_failed",
        startedAtMs,
      },
      dependencies.audit,
    );
    return {
      isError: true,
      content: [{ type: "text", text: failureMessage(error) }],
    };
  }
}

const positiveId = z.number().int().positive();
const pageSize = z.number().int().min(1).max(50).default(20);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const [year, month, day] = value.split("-").map(Number);
    const parsed = new Date(Date.UTC(year!, month! - 1, day!));
    return (
      parsed.getUTCFullYear() === year &&
      parsed.getUTCMonth() + 1 === month &&
      parsed.getUTCDate() === day
    );
  }, "Invalid calendar date");

export function registerConnectWiseBusinessTools(
  server: McpServer,
  env: object,
  getProps: () => AuthProps,
  dependencies: BusinessToolDependencies = {},
): void {
  const readAnnotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  } as const;
  const writeAnnotations = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  } as const;
  const financialWriteAnnotations = {
    ...writeAnnotations,
    destructiveHint: true,
  } as const;

  server.registerTool(
    "search_tickets_by_content",
    {
      description:
        "Search recent service-ticket summaries. Results and access are limited by the authenticated user's ConnectWise API member.",
      inputSchema: {
        searchText: z.string().trim().min(1).max(100),
        maxResults: pageSize,
      },
      annotations: readAnnotations,
    },
    ({ searchText, maxResults }) =>
      runBusinessTool(
        getProps(),
        env,
        "search_tickets_by_content",
        async (client) =>
          list(
            await client.searchServiceTickets(searchText, maxResults),
            maxResults,
          ).map(ticket),
        dependencies,
      ),
  );

  server.registerTool(
    "get_ticket_notes_with_content",
    {
      description:
        "Get bounded ticket-note content. ConnectWise API-member permissions determine access, including internal notes.",
      inputSchema: {
        ticketId: positiveId,
        includeInternal: z.boolean().default(true),
        includeExternal: z.boolean().default(true),
        maxResults: pageSize,
      },
      annotations: readAnnotations,
    },
    ({ ticketId, includeInternal, includeExternal, maxResults }) =>
      runBusinessTool(
        getProps(),
        env,
        "get_ticket_notes_with_content",
        async (client) =>
          list(await client.getTicketNotes(ticketId, maxResults), maxResults)
            .map(note)
            .filter(
              (entry) =>
                (includeInternal && entry.internal === true) ||
                (includeExternal && entry.external === true),
            ),
        dependencies,
      ),
  );

  server.registerTool(
    "get_ticket_attachments_with_details",
    {
      description:
        "List bounded attachment metadata for a ticket without downloading file content.",
      inputSchema: { ticketId: positiveId, maxResults: pageSize },
      annotations: readAnnotations,
    },
    ({ ticketId, maxResults }) =>
      runBusinessTool(
        getProps(),
        env,
        "get_ticket_attachments_with_details",
        async (client) =>
          list(
            await client.getTicketAttachments(ticketId, maxResults),
            maxResults,
          ).map(attachment),
        dependencies,
      ),
  );

  server.registerTool(
    "get_complete_ticket_content",
    {
      description:
        "Get a bounded ticket view including details, notes, attachment metadata, tasks, and time entries.",
      inputSchema: { ticketId: positiveId, maxResultsPerSection: pageSize },
      annotations: readAnnotations,
    },
    ({ ticketId, maxResultsPerSection }) =>
      runBusinessTool(
        getProps(),
        env,
        "get_complete_ticket_content",
        async (client) => {
          const [details, notes, attachments, tasks, timeEntries] =
            await Promise.all([
              client.getServiceTicket(ticketId),
              client.getTicketNotes(ticketId, maxResultsPerSection),
              client.getTicketAttachments(ticketId, maxResultsPerSection),
              client.getTicketTasks(ticketId, maxResultsPerSection),
              client.getTicketTimeEntries(ticketId, maxResultsPerSection),
            ]);
          return {
            ticket: ticket(details),
            notes: list(notes, maxResultsPerSection).map(note),
            attachments: list(attachments, maxResultsPerSection).map(
              attachment,
            ),
            tasks: list(tasks, maxResultsPerSection).map(task),
            timeEntries: list(timeEntries, maxResultsPerSection).map(timeEntry),
          };
        },
        dependencies,
      ),
  );

  server.registerTool(
    "create_ticket_note",
    {
      description:
        "Create a service or project ticket note using the authenticated user's ConnectWise API member permissions.",
      inputSchema: {
        ticketId: positiveId,
        text: z.string().trim().min(1).max(8_000),
        internalOnly: z.boolean().default(true),
        resolutionNote: z.boolean().default(false),
        issueNote: z.boolean().default(false),
      },
      annotations: writeAnnotations,
    },
    ({ ticketId, text: noteText, internalOnly, resolutionNote, issueNote }) =>
      runBusinessTool(
        getProps(),
        env,
        "create_ticket_note",
        async (client) => {
          const created = object(
            await client.createTicketNote(ticketId, {
              text: noteText,
              internalOnly,
              resolutionNote,
              issueNote,
            }),
          );
          const createdId = id(created?.id);
          if (createdId === undefined) {
            throw new Error("Invalid ConnectWise write response");
          }
          return compact({
            id: createdId,
            ticketId,
            internalOnly,
            resolutionNote,
            issueNote,
          });
        },
        dependencies,
      ),
  );

  server.registerTool(
    "get_agreement_additions",
    {
      description:
        "Get bounded agreement additions and commercial fields allowed by the authenticated ConnectWise API member.",
      inputSchema: { agreementId: positiveId, maxResults: pageSize },
      annotations: readAnnotations,
    },
    ({ agreementId, maxResults }) =>
      runBusinessTool(
        getProps(),
        env,
        "get_agreement_additions",
        async (client) =>
          list(
            await client.getAgreementAdditions(agreementId, maxResults),
            maxResults,
          ).map(addition),
        dependencies,
      ),
  );

  server.registerTool(
    "get_agreement_additions_summary",
    {
      description:
        "Summarize bounded agreement additions using data permitted to the user's ConnectWise API member.",
      inputSchema: { agreementId: positiveId, maxResults: pageSize },
      annotations: readAnnotations,
    },
    ({ agreementId, maxResults }) =>
      runBusinessTool(
        getProps(),
        env,
        "get_agreement_additions_summary",
        async (client) =>
          additionsSummary(
            list(
              await client.getAgreementAdditions(agreementId, maxResults),
              maxResults,
            ),
          ),
        dependencies,
      ),
  );

  server.registerTool(
    "create_agreement_addition",
    {
      description:
        "Create an agreement addition when the authenticated user's ConnectWise API member permits the financial write.",
      inputSchema: {
        agreementId: positiveId,
        productId: positiveId,
        quantity: z.number().positive().max(1_000_000),
        unitPrice: z.number().nonnegative().max(1_000_000_000),
        effectiveDate: date,
        description: z.string().trim().min(1).max(1_000).optional(),
        billableOption: z
          .enum(["Billable", "DoNotBill", "NoCharge"])
          .default("Billable"),
      },
      annotations: financialWriteAnnotations,
    },
    (input) =>
      runBusinessTool(
        getProps(),
        env,
        "create_agreement_addition",
        async (client) => {
          const created = object(
            await client.createAgreementAddition(input.agreementId, {
              productId: input.productId,
              quantity: input.quantity,
              unitPrice: input.unitPrice,
              effectiveDate: input.effectiveDate,
              billableOption: input.billableOption,
              ...(input.description === undefined
                ? {}
                : { description: input.description }),
            }),
          );
          const createdId = id(created?.id);
          if (createdId === undefined) {
            throw new Error("Invalid ConnectWise write response");
          }
          return compact({
            id: createdId,
            agreementId: input.agreementId,
            productId: input.productId,
            quantity: input.quantity,
            unitPrice: input.unitPrice,
            effectiveDate: input.effectiveDate,
            billableOption: input.billableOption,
          });
        },
        dependencies,
      ),
  );

  server.registerTool(
    "search_agreement_additions",
    {
      description:
        "Search a bounded set of additions within one agreement by product or date. ConnectWise permissions remain authoritative.",
      inputSchema: {
        agreementId: positiveId,
        productName: z.string().trim().min(1).max(100).optional(),
        dateFrom: date.optional(),
        dateTo: date.optional(),
        maxResults: pageSize,
      },
      annotations: readAnnotations,
    },
    ({ agreementId, productName, dateFrom, dateTo, maxResults }) =>
      runBusinessTool(
        getProps(),
        env,
        "search_agreement_additions",
        async (client) =>
          list(
            await client.getAgreementAdditions(agreementId, maxResults),
            maxResults,
          )
            .map(addition)
            .filter((entry) => {
              const name = object(entry.product)?.name;
              const effectiveDate = entry.effectiveDate;
              return (
                (!productName ||
                  (typeof name === "string" &&
                    name.toLowerCase().includes(productName.toLowerCase()))) &&
                (!dateFrom ||
                  (typeof effectiveDate === "string" &&
                    effectiveDate.slice(0, 10) >= dateFrom)) &&
                (!dateTo ||
                  (typeof effectiveDate === "string" &&
                    effectiveDate.slice(0, 10) <= dateTo))
              );
            }),
        dependencies,
      ),
  );

  server.registerTool(
    "get_agreement_billing_summary",
    {
      description:
        "Get bounded agreement, addition, and recent-invoice billing data permitted to the user's ConnectWise API member.",
      inputSchema: { agreementId: positiveId, maxAdditions: pageSize },
      annotations: readAnnotations,
    },
    ({ agreementId, maxAdditions }) =>
      runBusinessTool(
        getProps(),
        env,
        "get_agreement_billing_summary",
        async (client) => {
          const [agreementValue, additionValues, invoiceValues] =
            await Promise.all([
              client.getAgreement(agreementId),
              client.getAgreementAdditions(agreementId, maxAdditions),
              client.getRecentAgreementInvoices(agreementId, 5),
            ]);
          const rawAdditions = list(additionValues, maxAdditions);
          return {
            agreement: agreement(agreementValue),
            additions: additionsSummary(rawAdditions),
            recentInvoices: list(invoiceValues, 5).map(invoice),
          };
        },
        dependencies,
      ),
  );

  const lookupItem = (value: Record<string, unknown>) =>
    compact({
      id: id(value.id),
      name: text(value.name, 200),
      description: text(value.description, 500),
      rank: number(value.rank),
    });

  const boardItem = (value: Record<string, unknown>) =>
    compact({
      id: id(value.id),
      name: text(value.name, 200),
      description: text(value.description, 500),
      type: reference(value.type),
      owner: reference(value.owner),
    });

  const memberItem = (value: Record<string, unknown>) =>
    compact({
      id: id(value.id),
      name: text(value.name, 200),
      firstName: text(value.firstName, 100),
      lastName: text(value.lastName, 100),
      email: text(value.email, 200),
      phone: text(value.phone, 100),
      status: reference(value.status),
    });

  const companyItem = (value: Record<string, unknown>) =>
    compact({
      id: id(value.id),
      name: text(value.name, 300),
      phone: text(value.phone, 100),
      email: text(value.email, 200),
      address: text(value.address, 300),
      status: reference(value.status),
    });

  const contactItem = (value: Record<string, unknown>) =>
    compact({
      id: id(value.id),
      name: text(value.name, 200),
      firstName: text(value.firstName, 100),
      lastName: text(value.lastName, 100),
      title: text(value.title, 200),
      phone: text(value.phone, 100),
      cellPhone: text(value.cellPhone, 100),
      email: text(value.email, 200),
      company: reference(value.company),
    });

  const timeEntryRead = (value: Record<string, unknown>) =>
    compact({
      ...timeEntry(value),
      date: text(value.date, 100),
      chargeToType: text(value.chargeToType, 100),
    });

  const scheduleEntryItem = (value: Record<string, unknown>) =>
    compact({
      id: id(value.id),
      member: reference(value.member),
      start: text(value.start, 100),
      end: text(value.end, 100),
      description: text(value.description, 300),
      type: reference(value.type),
      status: reference(value.status),
    });

  const timeSheetItem = (value: Record<string, unknown>) =>
    compact({
      id: id(value.id),
      member: reference(value.member),
      startDate: text(value.startDate, 100),
      endDate: text(value.endDate, 100),
      status: reference(value.status),
    });

  const catalogItem = (value: Record<string, unknown>) => {
    const kept: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value)) {
      if (Object.keys(kept).length >= 10) break;
      if (typeof raw === "string" && raw.length > 0 && raw.length <= 300) {
        kept[key] = raw;
      } else if (typeof raw === "number" && Number.isFinite(raw)) {
        kept[key] = raw;
      } else if (typeof raw === "boolean") {
        kept[key] = raw;
      }
    }
    return kept;
  };

  server.registerTool(
    "get_service_boards",
    {
      description:
        "List service ticket boards. Access is limited by the authenticated user's ConnectWise API member.",
      inputSchema: {},
      annotations: readAnnotations,
    },
    () =>
      runBusinessTool(
        getProps(),
        env,
        "get_service_boards",
        (client) =>
          Promise.resolve(client.getServiceBoards()).then((value) =>
            list(value, 50).map(boardItem),
          ),
        dependencies,
      ),
  );

  server.registerTool(
    "get_board_options",
    {
      description:
        "Get the statuses and ticket types available on one service board.",
      inputSchema: { boardId: positiveId },
      annotations: readAnnotations,
    },
    ({ boardId }) =>
      runBusinessTool(
        getProps(),
        env,
        "get_board_options",
        async (client) => ({
          statuses: list(await client.getBoardStatuses(boardId), 50).map(
            lookupItem,
          ),
          types: list(await client.getBoardTypes(boardId), 50).map(lookupItem),
        }),
        dependencies,
      ),
  );

  server.registerTool(
    "list_board_tickets",
    {
      description:
        "List the most recent tickets on a service board. Results are limited by the authenticated user's ConnectWise API member.",
      inputSchema: { boardId: positiveId, maxResults: pageSize },
      annotations: readAnnotations,
    },
    ({ boardId, maxResults }) =>
      runBusinessTool(
        getProps(),
        env,
        "list_board_tickets",
        async (client) =>
          list(
            await client.listBoardTickets(boardId, maxResults),
            maxResults,
          ).map(ticket),
        dependencies,
      ),
  );

  server.registerTool(
    "get_service_statuses",
    {
      description:
        "List service ticket statuses. Access is limited by the authenticated user's ConnectWise API member.",
      inputSchema: {},
      annotations: readAnnotations,
    },
    () =>
      runBusinessTool(
        getProps(),
        env,
        "get_service_statuses",
        (client) =>
          Promise.resolve(client.getServiceStatuses()).then((value) =>
            list(value, 50).map(lookupItem),
          ),
        dependencies,
      ),
  );

  server.registerTool(
    "get_service_priorities",
    {
      description:
        "List service ticket priorities. Access is limited by the authenticated user's ConnectWise API member.",
      inputSchema: {},
      annotations: readAnnotations,
    },
    () =>
      runBusinessTool(
        getProps(),
        env,
        "get_service_priorities",
        (client) =>
          Promise.resolve(client.getServicePriorities()).then((value) =>
            list(value, 50).map(lookupItem),
          ),
        dependencies,
      ),
  );

  server.registerTool(
    "get_service_sources",
    {
      description:
        "List service ticket sources. Access is limited by the authenticated user's ConnectWise API member.",
      inputSchema: {},
      annotations: readAnnotations,
    },
    () =>
      runBusinessTool(
        getProps(),
        env,
        "get_service_sources",
        (client) =>
          Promise.resolve(client.getServiceSources()).then((value) =>
            list(value, 50).map(lookupItem),
          ),
        dependencies,
      ),
  );

  server.registerTool(
    "get_my_member",
    {
      description:
        "Get the authenticated user's ConnectWise member record, including ID, name, and contact details.",
      inputSchema: {},
      annotations: readAnnotations,
    },
    () =>
      runBusinessTool(
        getProps(),
        env,
        "get_my_member",
        (client) =>
          Promise.resolve(client.getMyMember()).then((value) => {
            const member = object(value);
            return member
              ? memberItem(member)
              : { message: "Member not found" };
          }),
        dependencies,
      ),
  );

  server.registerTool(
    "list_members",
    {
      description:
        "List ConnectWise team members. Access is limited by the authenticated user's ConnectWise API member.",
      inputSchema: { maxResults: pageSize },
      annotations: readAnnotations,
    },
    ({ maxResults }) =>
      runBusinessTool(
        getProps(),
        env,
        "list_members",
        async (client) =>
          list(await client.listMembers(maxResults), maxResults).map(
            memberItem,
          ),
        dependencies,
      ),
  );

  server.registerTool(
    "search_companies",
    {
      description:
        "Search ConnectWise companies by name. Access is limited by the authenticated user's ConnectWise API member.",
      inputSchema: {
        query: z.string().trim().min(1).max(100),
        maxResults: pageSize,
      },
      annotations: readAnnotations,
    },
    ({ query, maxResults }) =>
      runBusinessTool(
        getProps(),
        env,
        "search_companies",
        async (client) =>
          list(await client.searchCompanies(query, maxResults), maxResults)
            .map(companyItem)
            .filter((entry) => entry.id !== undefined || entry.name),
        dependencies,
      ),
  );

  server.registerTool(
    "search_contacts",
    {
      description:
        "Search ConnectWise contacts by name or email. Access is limited by the authenticated user's ConnectWise API member.",
      inputSchema: {
        query: z.string().trim().min(1).max(100),
        maxResults: pageSize,
      },
      annotations: readAnnotations,
    },
    ({ query, maxResults }) =>
      runBusinessTool(
        getProps(),
        env,
        "search_contacts",
        async (client) =>
          list(await client.searchContacts(query, maxResults), maxResults)
            .map(contactItem)
            .filter((entry) => entry.id !== undefined || entry.name),
        dependencies,
      ),
  );

  server.registerTool(
    "list_time_entries",
    {
      description:
        "List the most recent time entries. Access is limited by the authenticated user's ConnectWise API member.",
      inputSchema: { maxResults: pageSize },
      annotations: readAnnotations,
    },
    ({ maxResults }) =>
      runBusinessTool(
        getProps(),
        env,
        "list_time_entries",
        async (client) =>
          list(await client.listTimeEntries(maxResults), maxResults).map(
            timeEntryRead,
          ),
        dependencies,
      ),
  );

  server.registerTool(
    "list_schedule_entries",
    {
      description:
        "List the most recent schedule entries. Access is limited by the authenticated user's ConnectWise API member.",
      inputSchema: { maxResults: pageSize },
      annotations: readAnnotations,
    },
    ({ maxResults }) =>
      runBusinessTool(
        getProps(),
        env,
        "list_schedule_entries",
        async (client) =>
          list(await client.listScheduleEntries(maxResults), maxResults).map(
            scheduleEntryItem,
          ),
        dependencies,
      ),
  );

  server.registerTool(
    "get_time_sheets",
    {
      description:
        "List the most recent timesheets. Access is limited by the authenticated user's ConnectWise API member.",
      inputSchema: { maxResults: pageSize },
      annotations: readAnnotations,
    },
    ({ maxResults }) =>
      runBusinessTool(
        getProps(),
        env,
        "get_time_sheets",
        async (client) =>
          list(await client.getTimeSheets(maxResults), maxResults).map(
            timeSheetItem,
          ),
        dependencies,
      ),
  );

  server.registerTool(
    "get_document",
    {
      description:
        "Get metadata for a ConnectWise document by ID. Use the catalog route 'system.documents' to list documents for a record.",
      inputSchema: { documentId: positiveId },
      annotations: readAnnotations,
    },
    ({ documentId }) =>
      runBusinessTool(
        getProps(),
        env,
        "get_document",
        (client) =>
          Promise.resolve(client.getDocument(documentId)).then((value) => {
            const document = object(value);
            return document
              ? attachment(document)
              : { message: "Document not found" };
          }),
        dependencies,
      ),
  );

  server.registerTool(
    "download_document",
    {
      description:
        "Download a ConnectWise document as base64 (8 MB maximum). Returns base64 content, MIME type, and byte length.",
      inputSchema: { documentId: positiveId },
      annotations: readAnnotations,
    },
    ({ documentId }) =>
      runBusinessTool(
        getProps(),
        env,
        "download_document",
        (client) => client.downloadDocument(documentId),
        dependencies,
      ),
  );

  server.registerTool(
    "call_connectwise",
    {
      description:
        "Read-only ConnectWise catalog lookup. Pick a route ID and provide its required parameters. Routes: " +
        CATALOG_ROUTE_IDS.join(", ") +
        ". All routes are GET-only with allowlisted parameters and bounded output.",
      inputSchema: {
        route: z.enum(CATALOG_ROUTE_IDS),
        boardId: positiveId.optional(),
        statusId: positiveId.optional(),
        memberId: positiveId.optional(),
        recordId: positiveId.optional(),
        recordType: z
          .enum([
            "Ticket",
            "Project",
            "Agreement",
            "Company",
            "Contact",
            "Vendor",
          ])
          .optional(),
        name: z.string().trim().min(1).max(100).optional(),
        query: z.string().trim().min(1).max(100).optional(),
        pageSize: pageSize,
      },
      annotations: readAnnotations,
    },
    ({
      route,
      boardId,
      statusId,
      memberId,
      recordId,
      recordType,
      name,
      query,
      pageSize,
    }) =>
      runBusinessTool(
        getProps(),
        env,
        "call_connectwise",
        async (client) => {
          const params: Record<string, string | number> = { pageSize };
          if (boardId !== undefined) params.boardId = boardId;
          if (statusId !== undefined) params.statusId = statusId;
          if (memberId !== undefined) params.memberId = memberId;
          if (recordId !== undefined) params.recordId = recordId;
          if (recordType !== undefined) params.recordType = recordType;
          if (name !== undefined) params.name = name;
          if (query !== undefined) params.query = query;
          return list(await client.catalogGet(route, params), pageSize).map(
            catalogItem,
          );
        },
        dependencies,
      ),
  );
}
