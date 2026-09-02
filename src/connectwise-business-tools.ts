import { type CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  CATALOG_ROUTE_IDS,
  CONNECTWISE_IMAGE_MIME_TYPES,
  ConnectWiseDownloadError,
  ConnectWiseRequestError,
  ConnectWiseUserError,
  MAX_IMAGE_UPLOAD_BYTES,
  createConnectWiseClient,
  ghostScheduleEntries,
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
import { ATTACHMENT_UPLOADER_HTML } from "./generated/attachment-uploader-html";

const ATTACHMENT_UPLOADER_RESOURCE_URI =
  "ui://connectwise/attachment-uploader.html";
const ATTACHMENT_UPLOADER_MIME_TYPE = "text/html;profile=mcp-app";

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
    closedFlag: boolean(parsed.closedFlag),
    closedDate: text(parsed.closedDate, 100),
    dateResolved: text(parsed.dateResolved, 100),
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
    if (error.status === 401 || error.status === 403) {
      return "ConnectWise denied this operation";
    }
    if (error.status === 404) return "ConnectWise record not found";
    if (error.status === 429) return "ConnectWise rate limit reached";
    if (error.status >= 500) return "ConnectWise service unavailable";
    return "ConnectWise request failed";
  }
  if (error instanceof ConnectWiseDownloadError) {
    return "ConnectWise download failed";
  }
  if (error instanceof ConnectWiseUserError) {
    if (error.code === "timezone_required")
      return "Date/time values require an explicit timezone offset";
    if (error.code === "timesheet_pending")
      return "A timesheet is pending approval; the write was not performed";
    if (error.code === "invalid_board_status")
      return "The selected status is not valid on the selected board";
  }
  return "ConnectWise operation failed";
}

const WRITE_TOOLS: ReadonlySet<ToolAuditName> = new Set([
  "upload_connectwise_image",
  "create_ticket_note",
  "attach_image_to_ticket",
  "attach_image_to_time_entry",
  "create_agreement_addition",
  "create_service_ticket",
  "update_service_ticket",
  "create_schedule_entry",
  "update_schedule_entry",
  "delete_schedule_entry",
  "create_time_entry",
]);

async function runBusinessTool(
  props: AuthProps,
  env: object,
  tool: ToolAuditName,
  operation: (client: ConnectWiseClient) => Promise<unknown>,
  dependencies: BusinessToolDependencies,
): Promise<CallToolResult> {
  const startedAtMs = getAuditStartTime(dependencies.audit);
  if (
    !props?.scopes?.includes("mcp:read") ||
    (WRITE_TOOLS.has(tool) && !props.scopes.includes("mcp:write"))
  ) {
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

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};
const MAX_IMAGE_BYTES = 10_000_000;
const MAX_IMAGE_BASE64_CHARS = Math.ceil((MAX_IMAGE_BYTES / 3) * 4);
const IMAGE_DATA_URI_PATTERN =
  /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/;

const image = z
  .string()
  .min(1)
  .refine((value) => {
    const match = IMAGE_DATA_URI_PATTERN.exec(value);
    return match !== null && (match[2] ?? "").length <= MAX_IMAGE_BASE64_CHARS;
  }, "Expected a base64 image data URI (png, jpeg, webp, or gif), 10 MB maximum");

type ImagePayload = {
  base64: string;
  mimeType: string;
  extension: string;
};

function imageFromDataUri(value: string): ImagePayload {
  const match = IMAGE_DATA_URI_PATTERN.exec(value);
  const mimeType = match?.[1];
  const base64 = match?.[2];
  if (
    mimeType === undefined ||
    base64 === undefined ||
    base64.length === 0 ||
    base64.length > MAX_IMAGE_BASE64_CHARS
  ) {
    throw new Error(
      "Expected a base64 image data URI (png, jpeg, webp, or gif), 10 MB maximum",
    );
  }
  return {
    base64,
    mimeType,
    extension: IMAGE_EXTENSIONS[mimeType] ?? "png",
  };
}

function attachmentFilename(
  value: string | undefined,
  extension: string,
): string {
  const fallback = `image.${extension}`;
  if (value === undefined) return fallback;
  const cleaned = value
    .normalize("NFKC")
    .slice(0, 200)
    .replace(/[^A-Za-z0-9 ._()\-]/g, "")
    .trim();
  return /^[A-Za-z0-9][A-Za-z0-9 ._()\-]*\.[A-Za-z0-9]{1,10}$/.test(cleaned)
    ? cleaned
    : fallback;
}

function inlineImageTag(attachmentUrl: unknown): string {
  const url = text(attachmentUrl, 1_000);
  if (
    url === undefined ||
    !/^https:\/\/[A-Za-z0-9._~\/?#@!$&*+,;=%-]+$/.test(url)
  ) {
    throw new Error("ConnectWise did not return a usable attachment link");
  }
  return `\n<img src="${url.replaceAll("&", "&amp;")}">`;
}

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

  server.registerResource(
    "ConnectWise attachment uploader",
    ATTACHMENT_UPLOADER_RESOURCE_URI,
    {
      title: "ConnectWise image uploader",
      description:
        "Paste, drop, or choose an image and attach it to a ConnectWise ticket or time entry.",
      mimeType: ATTACHMENT_UPLOADER_MIME_TYPE,
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: ATTACHMENT_UPLOADER_MIME_TYPE,
          text: ATTACHMENT_UPLOADER_HTML,
          _meta: {
            ui: {
              csp: {
                connectDomains: [],
                resourceDomains: [],
              },
            },
          },
        },
      ],
    }),
  );

  server.registerTool(
    "open_attachment_uploader",
    {
      title: "Attach an image to ConnectWise",
      description:
        "Open a secure inline uploader for pasting, dropping, or choosing an image. The image can be attached to a ticket (with an optional ticket note) or an existing time entry.",
      inputSchema: {
        recordType: z.enum(["Ticket", "TimeEntry"]).default("Ticket"),
        recordId: positiveId.optional(),
      },
      annotations: readAnnotations,
      _meta: {
        ui: { resourceUri: ATTACHMENT_UPLOADER_RESOURCE_URI },
      },
    },
    ({ recordType, recordId }) =>
      runBusinessTool(
        getProps(),
        env,
        "open_attachment_uploader",
        async () => ({
          recordType,
          recordId: recordId ?? null,
          maxImageBytes: MAX_IMAGE_UPLOAD_BYTES,
          allowedMimeTypes: CONNECTWISE_IMAGE_MIME_TYPES,
        }),
        dependencies,
      ),
  );

  server.registerTool(
    "upload_connectwise_image",
    {
      title: "Upload a ConnectWise image",
      description:
        "App-only image upload used by the inline ConnectWise attachment uploader.",
      inputSchema: {
        recordType: z.enum(["Ticket", "TimeEntry"]),
        recordId: positiveId,
        fileName: z.string().trim().min(1).max(128),
        mimeType: z.enum(CONNECTWISE_IMAGE_MIME_TYPES),
        base64: z
          .string()
          .min(4)
          .max(4 * Math.ceil(MAX_IMAGE_UPLOAD_BYTES / 3)),
        title: z.string().trim().min(1).max(200).optional(),
        privateFlag: z.boolean().default(true),
      },
      annotations: writeAnnotations,
      _meta: {
        ui: { visibility: ["app"] },
      },
    },
    ({
      recordType,
      recordId,
      fileName,
      mimeType,
      base64,
      title,
      privateFlag,
    }) =>
      runBusinessTool(
        getProps(),
        env,
        "upload_connectwise_image",
        async (client) => {
          const created = object(
            await client.uploadImageDocument(recordType, recordId, {
              fileName,
              mimeType,
              base64,
              ...(title === undefined ? {} : { title }),
              privateFlag,
            }),
          );
          const document = created ? attachment(created) : {};
          if (document.id === undefined) {
            throw new Error("Invalid ConnectWise upload response");
          }
          return {
            recordType,
            recordId,
            document,
          };
        },
        dependencies,
      ),
  );

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
        "Create a service or project ticket note using the authenticated user's ConnectWise API member permissions. Pass image (base64 data URI) to attach it to the ticket first and inline it in the note.",
      inputSchema: {
        ticketId: positiveId,
        text: z.string().trim().min(1).max(8_000),
        image: image.optional(),
        internalOnly: z.boolean().default(true),
        resolutionNote: z.boolean().default(false),
        issueNote: z.boolean().default(false),
      },
      annotations: writeAnnotations,
    },
    ({
      ticketId,
      text: noteText,
      image: imageValue,
      internalOnly,
      resolutionNote,
      issueNote,
    }) =>
      runBusinessTool(
        getProps(),
        env,
        "create_ticket_note",
        async (client) => {
          let imageRef = "";
          if (imageValue !== undefined) {
            const payload = imageFromDataUri(imageValue);
            const resolvedFilename = attachmentFilename(
              undefined,
              payload.extension,
            );
            const attached = object(
              await client.attachImageToTicket(ticketId, {
                filename: resolvedFilename,
                base64: payload.base64,
                mimeType: payload.mimeType,
              }),
            );
            if (id(attached?.id) === undefined) {
              throw new Error("Invalid ConnectWise write response");
            }
            imageRef = inlineImageTag(attached?.url);
          }
          const created = object(
            await client.createTicketNote(ticketId, {
              text: noteText + imageRef,
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
            ...(imageValue !== undefined ? { imageAttached: true } : {}),
          });
        },
        dependencies,
      ),
  );

  server.registerTool(
    "attach_image_to_ticket",
    {
      description:
        "Attach an image from the chat (base64 data URI, 10 MB maximum) to a ConnectWise ticket using the authenticated user's ConnectWise API member permissions.",
      inputSchema: {
        ticketId: positiveId,
        image,
        filename: z.string().trim().min(1).max(200).optional(),
      },
      annotations: writeAnnotations,
    },
    ({ ticketId, image: imageValue, filename }) =>
      runBusinessTool(
        getProps(),
        env,
        "attach_image_to_ticket",
        async (client) => {
          const payload = imageFromDataUri(imageValue);
          const resolvedFilename = attachmentFilename(
            filename,
            payload.extension,
          );
          const created = object(
            await client.attachImageToTicket(ticketId, {
              filename: resolvedFilename,
              base64: payload.base64,
              mimeType: payload.mimeType,
            }),
          );
          const createdId = id(created?.id);
          if (createdId === undefined) {
            throw new Error("Invalid ConnectWise write response");
          }
          return compact({
            id: createdId,
            ticketId,
            filename: resolvedFilename,
            mimeType: payload.mimeType,
            url: text(created?.url, 1_000),
            size: number(created?.size),
          });
        },
        dependencies,
      ),
  );

  server.registerTool(
    "attach_image_to_time_entry",
    {
      description:
        "Attach an image from the chat (base64 data URI, 10 MB maximum) to a ConnectWise time entry using the authenticated user's ConnectWise API member permissions.",
      inputSchema: {
        timeEntryId: positiveId,
        image,
        filename: z.string().trim().min(1).max(200).optional(),
      },
      annotations: writeAnnotations,
    },
    ({ timeEntryId, image: imageValue, filename }) =>
      runBusinessTool(
        getProps(),
        env,
        "attach_image_to_time_entry",
        async (client) => {
          const payload = imageFromDataUri(imageValue);
          const resolvedFilename = attachmentFilename(
            filename,
            payload.extension,
          );
          const created = object(
            await client.attachImageToTimeEntry(timeEntryId, {
              filename: resolvedFilename,
              base64: payload.base64,
              mimeType: payload.mimeType,
            }),
          );
          const createdId = id(created?.id);
          if (createdId === undefined) {
            throw new Error("Invalid ConnectWise write response");
          }
          return compact({
            id: createdId,
            timeEntryId,
            filename: resolvedFilename,
            mimeType: payload.mimeType,
            url: text(created?.url, 1_000),
            size: number(created?.size),
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

  // CW schedule entries use dateStart/dateEnd and name (live-verified).
  const scheduleEntryItem = (value: Record<string, unknown>) =>
    compact({
      id: id(value.id),
      member: reference(value.member),
      start: text(value.dateStart, 100),
      end: text(value.dateEnd, 100),
      name: text(value.name, 300),
      hours: number(value.hours),
      done: boolean(value.doneFlag),
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

  const configurationItem = (value: Record<string, unknown>) =>
    compact({
      id: id(value.id),
      name: text(value.name, 300),
      type: reference(value.type),
      status: reference(value.status),
      company: reference(value.company),
      site: reference(value.site),
      contact: reference(value.contact),
    });

  const catalogProjectors: Record<
    (typeof CATALOG_ROUTE_IDS)[number],
    (value: Record<string, unknown>) => Record<string, unknown>
  > = {
    "service.boards.statuses": lookupItem,
    "service.boards.types": lookupItem,
    "service.tickets.byStatus": ticket,
    "service.tickets.byOwner": ticket,
    "company.configurations": configurationItem,
    "system.documents": attachment,
    "finance.agreements.byName": agreement,
    "time.entries.byMember": timeEntryRead,
    "schedule.entries.byMember": scheduleEntryItem,
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
        "Read-only ConnectWise catalog lookup. [BUILD-MARKER 4421014b-2026-08-30] Pick a route ID and provide its required parameters. Routes: " +
        CATALOG_ROUTE_IDS.join(", ") +
        ". schedule.entries.byMember accepts optional startDate/endDate (YYYY-MM-DD, at most a 31-day span) and returns entries ordered by dateStart. service.tickets.byOwner filters on ticket OWNER (owner/id), not assigned resources; it returns open tickets by default (closedFlag=false) — pass includeClosed:'true' to include closed ones, and returns status, board, priority, owner, contact, closedDate and dateResolved. All routes are GET-only with allowlisted parameters and bounded output.",
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
        startDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        endDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        includeClosed: z.enum(["true", "false"]).optional(),
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
      startDate,
      endDate,
      includeClosed,
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
          if (startDate !== undefined) params.startDate = startDate;
          if (endDate !== undefined) params.endDate = endDate;
          if (includeClosed !== undefined) {
            params.includeClosed = includeClosed;
          }
          const project = catalogProjectors[route];
          return list(await client.catalogGet(route, params), pageSize).map(
            project,
          );
        },
        dependencies,
      ),
  );

  server.registerTool(
    "create_service_ticket",
    {
      description:
        "Create a ConnectWise service ticket. companyId and summary are required and never defaulted. Defaults: boardId 32 (Triage), statusId 547 (New). New tickets default to Priority 4 - Low and a placeholder type ('-CHANGE BOARD FIRST-') until they are corrected on a real board — the created ticket shows these so the caller knows to fix them. initialDescription is posted as the ticket's initial description note. Returns an allowlisted ticket receipt.",
      inputSchema: {
        companyId: positiveId,
        summary: z.string().trim().min(1).max(100),
        boardId: positiveId.optional(),
        statusId: positiveId.optional(),
        contactId: positiveId.optional(),
        priorityId: positiveId.optional(),
        typeId: positiveId.optional(),
        ownerId: positiveId.optional(),
        initialDescription: z.string().trim().min(1).max(8_000).optional(),
      },
      annotations: writeAnnotations,
    },
    ({
      companyId,
      summary,
      boardId,
      statusId,
      contactId,
      priorityId,
      typeId,
      ownerId,
      initialDescription,
    }) =>
      runBusinessTool(
        getProps(),
        env,
        "create_service_ticket",
        (client) =>
          client
            .createServiceTicket({
              companyId,
              summary,
              ...(boardId !== undefined ? { boardId } : {}),
              ...(statusId !== undefined ? { statusId } : {}),
              ...(contactId !== undefined ? { contactId } : {}),
              ...(priorityId !== undefined ? { priorityId } : {}),
              ...(typeId !== undefined ? { typeId } : {}),
              ...(ownerId !== undefined ? { ownerId } : {}),
              ...(initialDescription !== undefined
                ? { initialDescription }
                : {}),
            })
            .then(ticket),
        dependencies,
      ),
  );

  server.registerTool(
    "update_service_ticket",
    {
      description:
        "Update an existing ConnectWise service ticket. Only the fields you pass change: the client GETs the ticket first, merges, then PUTs — unpassed fields (company, contact, dates, costs) survive. A board move auto-generates a zero-hour ghost schedule entry on the ticket; this tool detects it and removes it in the same operation (reported in the response). Status is board-scoped: a status that is not valid on the target board is rejected with the valid statuses listed.",
      inputSchema: {
        ticketId: positiveId,
        ownerId: positiveId.optional(),
        statusId: positiveId.optional(),
        boardId: positiveId.optional(),
        priorityId: positiveId.optional(),
        typeId: positiveId.optional(),
        summary: z.string().trim().min(1).max(100).optional(),
        contactId: positiveId.optional(),
      },
      annotations: writeAnnotations,
    },
    ({
      ticketId,
      ownerId,
      statusId,
      boardId,
      priorityId,
      typeId,
      summary,
      contactId,
    }) =>
      runBusinessTool(
        getProps(),
        env,
        "update_service_ticket",
        async (client) => {
          // Board-scoped status validation, before any write. When a board is
          // being set, the status must be valid there.
          if (boardId !== undefined && statusId !== undefined) {
            const statuses = (await client.getBoardStatuses(boardId)) as Array<{
              id?: number;
              name?: string;
            }>;
            const valid = Array.isArray(statuses) ? statuses : [];
            if (!valid.some((s) => Number(s.id) === statusId)) {
              throw new ConnectWiseUserError("invalid_board_status");
            }
          }
          return client
            .updateServiceTicket(ticketId, {
              ...(ownerId !== undefined ? { ownerId } : {}),
              ...(statusId !== undefined ? { statusId } : {}),
              ...(boardId !== undefined ? { boardId } : {}),
              ...(priorityId !== undefined ? { priorityId } : {}),
              ...(typeId !== undefined ? { typeId } : {}),
              ...(summary !== undefined ? { summary } : {}),
              ...(contactId !== undefined ? { contactId } : {}),
            })
            .then(async (updated) => {
              // A board move auto-generates a zero-hour ghost schedule entry
              // on the ticket. Detect it and remove it in the same operation.
              if (boardId !== undefined) {
                const entries =
                  await client.openScheduleEntriesForObject(ticketId);
                const ghosts = ghostScheduleEntries(entries);
                for (const ghost of ghosts) {
                  await client.deleteScheduleEntry(ghost.id);
                }
                if (ghosts.length > 0)
                  return {
                    ...ticket(updated),
                    ghostScheduleEntryIdsRemoved: ghosts.map((g) => g.id),
                  };
              }
              return ticket(updated);
            });
        },
        dependencies,
      ),
  );

  server.registerTool(
    "create_schedule_entry",
    {
      description:
        "Create a schedule entry on a member's calendar. memberId is always explicit — never defaulted. dateStart/dateEnd must be ISO 8601 WITH an explicit timezone offset (e.g. 2026-08-31T08:30:00-04:00); bare local or bare UTC times are rejected and converted to UTC server-side, so what lands on the calendar is always unambiguous. objectId is the ticket/record the entry attaches to and is required for service entries (objectType 4). allowConflicts defaults to false and sends allowScheduleConflictsFlag only when true. whereId sets the location (e.g. on-site vs Remote); omit to use the member's default. Returns the created entry with its stored UTC times.",
      inputSchema: {
        memberId: positiveId,
        dateStart: z.string(),
        dateEnd: z.string(),
        objectId: positiveId.optional(),
        objectType: z.number().int().min(1).max(100).optional(),
        statusId: positiveId.optional(),
        allowConflicts: z.boolean().optional(),
        doneFlag: z.boolean().optional(),
        name: z.string().trim().min(1).max(500).optional(),
        whereId: positiveId.optional(),
      },
      annotations: writeAnnotations,
    },
    ({
      memberId,
      dateStart,
      dateEnd,
      objectId,
      objectType,
      statusId,
      allowConflicts,
      doneFlag,
      name,
      whereId,
    }) =>
      runBusinessTool(
        getProps(),
        env,
        "create_schedule_entry",
        (client) =>
          client
            .createScheduleEntry({
              memberId,
              dateStart,
              dateEnd,
              ...(objectId !== undefined ? { objectId } : {}),
              ...(objectType !== undefined ? { objectType } : {}),
              ...(statusId !== undefined ? { statusId } : {}),
              ...(allowConflicts !== undefined ? { allowConflicts } : {}),
              ...(doneFlag !== undefined ? { doneFlag } : {}),
              ...(name !== undefined ? { name } : {}),
              ...(whereId !== undefined ? { whereId } : {}),
            })
            .then((value) => scheduleEntryItem(object(value) ?? {})),
        dependencies,
      ),
  );

  server.registerTool(
    "update_schedule_entry",
    {
      description:
        "Update an existing schedule entry. Only the fields you pass change: the client GETs the entry first, merges, then PUTs the merged record — unpassed fields (member, objectId, type, notes) survive unchanged instead of being blanked. dateStart/dateEnd require an explicit timezone offset like create_schedule_entry. Returns the updated entry.",
      inputSchema: {
        entryId: positiveId,
        dateStart: z.string().optional(),
        dateEnd: z.string().optional(),
        statusId: positiveId.optional(),
        doneFlag: z.boolean().optional(),
        name: z.string().trim().min(1).max(500).optional(),
        allowConflicts: z.boolean().optional(),
        whereId: positiveId.optional(),
      },
      annotations: writeAnnotations,
    },
    ({
      entryId,
      dateStart,
      dateEnd,
      statusId,
      doneFlag,
      name,
      allowConflicts,
      whereId,
    }) =>
      runBusinessTool(
        getProps(),
        env,
        "update_schedule_entry",
        (client) =>
          client
            .updateScheduleEntry(entryId, {
              ...(dateStart !== undefined ? { dateStart } : {}),
              ...(dateEnd !== undefined ? { dateEnd } : {}),
              ...(statusId !== undefined ? { statusId } : {}),
              ...(doneFlag !== undefined ? { doneFlag } : {}),
              ...(name !== undefined ? { name } : {}),
              ...(allowConflicts !== undefined ? { allowConflicts } : {}),
              ...(whereId !== undefined ? { whereId } : {}),
            })
            .then((value) => scheduleEntryItem(object(value) ?? {})),
        dependencies,
      ),
  );

  server.registerTool(
    "delete_schedule_entry",
    {
      description:
        "Permanently delete a schedule entry by ID. Use for ghost entries left by failed UI/PUT operations. This is destructive and cannot be undone.",
      inputSchema: { entryId: positiveId },
      annotations: financialWriteAnnotations,
    },
    ({ entryId }) =>
      runBusinessTool(
        getProps(),
        env,
        "delete_schedule_entry",
        (client) => client.deleteScheduleEntry(entryId),
        dependencies,
      ),
  );

  server.registerTool(
    "create_time_entry",
    {
      description:
        "Create a time entry for a member. timeStart/timeEnd must be ISO 8601 WITH an explicit timezone offset (converted to UTC server-side). If a timesheet is pending approval the write is refused with a clear instruction to recall/approve it first. Known charge mappings: Unprofitable chargeTo 13/workType 25/DoNotBill; Vacation chargeTo 2/workType 7/NoCharge; Sick chargeTo 7/workType 6/NoCharge. Returns the created entry.",
      inputSchema: {
        memberId: positiveId,
        timeStart: z.string(),
        timeEnd: z.string(),
        notes: z.string().trim().min(1).max(2000).optional(),
        ticketId: positiveId.optional(),
        chargeToId: positiveId.optional(),
        workTypeId: positiveId.optional(),
        billableOption: z
          .enum(["Billable", "DoNotBill", "NoCharge"])
          .optional(),
      },
      annotations: writeAnnotations,
    },
    ({
      memberId,
      timeStart,
      timeEnd,
      notes,
      ticketId,
      chargeToId,
      workTypeId,
      billableOption,
    }) =>
      runBusinessTool(
        getProps(),
        env,
        "create_time_entry",
        (client) =>
          client
            .createTimeEntry({
              memberId,
              timeStart,
              timeEnd,
              ...(notes !== undefined ? { notes } : {}),
              ...(ticketId !== undefined ? { ticketId } : {}),
              ...(chargeToId !== undefined ? { chargeToId } : {}),
              ...(workTypeId !== undefined ? { workTypeId } : {}),
              ...(billableOption !== undefined ? { billableOption } : {}),
            })
            .then((value) => timeEntryRead(object(value) ?? {})),
        dependencies,
      ),
  );
}
