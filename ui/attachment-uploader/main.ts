import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import "./styles.css";

const MAX_ORIGINAL_BYTES = 20_000_000;
const MAX_UPLOAD_BYTES = 1_000_000;
const TARGET_COMPRESSED_BYTES = 900_000;
const MAX_IMAGE_PIXELS = 25_000_000;
const allowedMimeTypes = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const;

type ImageMimeType = (typeof allowedMimeTypes)[number];
type RecordType = "Ticket" | "TimeEntry";
type PreparedImage = {
  blob: Blob;
  base64: string;
  fileName: string;
  mimeType: ImageMimeType;
};

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error("Missing UI element: " + id);
  return found as T;
}

const appElement = element<HTMLElement>("app");
const form = element<HTMLFormElement>("upload-form");
const recordType = element<HTMLSelectElement>("record-type");
const recordId = element<HTMLInputElement>("record-id");
const recordIdLabel = element<HTMLElement>("record-id-label");
const fileInput = element<HTMLInputElement>("file-input");
const dropZone = element<HTMLButtonElement>("drop-zone");
const previewCard = element<HTMLElement>("preview-card");
const preview = element<HTMLImageElement>("preview");
const fileNameElement = element<HTMLElement>("file-name");
const fileDetails = element<HTMLElement>("file-details");
const title = element<HTMLInputElement>("title");
const visibility = element<HTMLSelectElement>("visibility");
const notePanel = element<HTMLElement>("note-panel");
const noteText = element<HTMLTextAreaElement>("note-text");
const internalOnly = element<HTMLInputElement>("internal-only");
const resolutionNote = element<HTMLInputElement>("resolution-note");
const issueNote = element<HTMLInputElement>("issue-note");
const submit = element<HTMLButtonElement>("submit");
const status = element<HTMLElement>("status");

let preparedImage: PreparedImage | undefined;
let previewUrl: string | undefined;
let submitting = false;
const app = new App({
  name: "ConnectWise attachment uploader",
  version: "1.0.0",
});

function setStatus(message: string, kind?: "success" | "error"): void {
  status.textContent = message;
  status.className = "status" + (kind ? " " + kind : "");
}

function setBusy(busy: boolean): void {
  submitting = busy;
  submit.disabled = busy || preparedImage === undefined;
  submit.textContent = busy ? "Uploading…" : "Attach image";
}

function clearPreparedImage(): void {
  preparedImage = undefined;
  fileInput.value = "";
  previewCard.hidden = true;
  if (previewUrl) {
    URL.revokeObjectURL(previewUrl);
    previewUrl = undefined;
  }
}

function syncTarget(): void {
  const isTicket = recordType.value === "Ticket";
  recordIdLabel.textContent = isTicket ? "Ticket ID" : "Time entry ID";
  notePanel.hidden = !isTicket;
}

function safeFileName(original: string, mimeType: ImageMimeType): string {
  const extension: Record<ImageMimeType, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
  };
  const withoutExtension = original.replace(/\.[^.]*$/, "");
  let base = withoutExtension
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._ ()-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .trim()
    .slice(0, 100);
  if (!base) base = "connectwise-image";
  return base + extension[mimeType];
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("The image could not be read"));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string" || !result.includes(",")) {
        reject(new Error("The image could not be encoded"));
        return;
      }
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.readAsDataURL(blob);
  });
}

function loadImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("The selected file is not a readable image"));
    };
    image.src = url;
  });
}

function canvasBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(new Error("The image could not be resized")),
      "image/jpeg",
      quality,
    );
  });
}

async function compressImage(file: File): Promise<Blob> {
  if (file.type === "image/gif") {
    throw new Error("GIF images larger than 1 MB cannot be resized");
  }
  const image = await loadImage(file);
  const pixels = image.naturalWidth * image.naturalHeight;
  if (
    image.naturalWidth < 1 ||
    image.naturalHeight < 1 ||
    pixels > MAX_IMAGE_PIXELS
  ) {
    throw new Error("The image dimensions are too large");
  }
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Image resizing is unavailable");

  const initialScale = Math.min(
    1,
    1800 / Math.max(image.naturalWidth, image.naturalHeight),
  );
  let width = Math.max(1, Math.round(image.naturalWidth * initialScale));
  let height = Math.max(1, Math.round(image.naturalHeight * initialScale));
  let quality = 0.9;

  for (let attempt = 0; attempt < 9; attempt += 1) {
    canvas.width = width;
    canvas.height = height;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    const compressed = await canvasBlob(canvas, quality);
    if (compressed.size <= TARGET_COMPRESSED_BYTES) return compressed;
    width = Math.max(320, Math.round(width * 0.82));
    height = Math.max(240, Math.round(height * 0.82));
    quality = Math.max(0.58, quality - 0.05);
  }
  throw new Error("The image could not be reduced below the 1 MB limit");
}

function isAllowedMimeType(value: string): value is ImageMimeType {
  return (allowedMimeTypes as readonly string[]).includes(value);
}

async function prepareImage(file: File): Promise<void> {
  if (!isAllowedMimeType(file.type)) {
    throw new Error("Choose a PNG, JPEG, GIF, or WebP image");
  }
  if (file.size < 1 || file.size > MAX_ORIGINAL_BYTES) {
    throw new Error("Choose an image between 1 byte and 20 MB");
  }
  setStatus(
    file.size > MAX_UPLOAD_BYTES ? "Resizing image locally…" : "Reading image…",
  );
  const blob = file.size > MAX_UPLOAD_BYTES ? await compressImage(file) : file;
  if (blob.size > MAX_UPLOAD_BYTES) {
    throw new Error("The prepared image is larger than 1 MB");
  }
  const mimeType = blob.type === "image/jpeg" ? "image/jpeg" : file.type;
  if (!isAllowedMimeType(mimeType)) {
    throw new Error("The prepared image type is unsupported");
  }
  const fileName = safeFileName(file.name, mimeType);
  const base64 = await blobToBase64(blob);
  preparedImage = { blob, base64, fileName, mimeType };

  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(blob);
  preview.src = previewUrl;
  fileNameElement.textContent = fileName;
  fileDetails.textContent =
    mimeType + " · " + String(Math.ceil(blob.size / 1024)) + " KB";
  previewCard.hidden = false;
  if (!title.value.trim()) title.value = fileName;
  setStatus(
    file.size > MAX_UPLOAD_BYTES
      ? "Image resized locally and ready to upload."
      : "Image ready to upload.",
  );
  setBusy(false);
}

async function acceptFile(file: File | undefined): Promise<void> {
  if (!file || submitting) return;
  try {
    await prepareImage(file);
  } catch (error) {
    preparedImage = undefined;
    previewCard.hidden = true;
    setBusy(false);
    setStatus(
      error instanceof Error
        ? error.message
        : "The image could not be prepared",
      "error",
    );
  }
}

function textResult(result: CallToolResult): string {
  for (const content of result.content) {
    if (content.type === "text") return content.text;
  }
  return result.isError ? "ConnectWise operation failed" : "";
}

function resultId(
  result: CallToolResult,
  path: "document" | "note",
): number | undefined {
  try {
    const parsed = JSON.parse(textResult(result)) as {
      document?: { id?: unknown };
      id?: unknown;
    };
    const value = path === "document" ? parsed.document?.id : parsed.id;
    return typeof value === "number" && Number.isSafeInteger(value)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

recordType.addEventListener("change", syncTarget);
dropZone.addEventListener("click", () => fileInput.click());
dropZone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") fileInput.click();
});
fileInput.addEventListener("change", () => {
  void acceptFile(fileInput.files?.[0]);
});
dropZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropZone.classList.add("dragging");
});
dropZone.addEventListener("dragleave", () => {
  dropZone.classList.remove("dragging");
});
dropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropZone.classList.remove("dragging");
  void acceptFile(event.dataTransfer?.files[0]);
});
document.addEventListener("paste", (event) => {
  const files = Array.from(event.clipboardData?.files ?? []);
  const file = files.find((entry) => entry.type.startsWith("image/"));
  if (file) {
    event.preventDefault();
    void acceptFile(file);
  }
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void submitUpload();
});

async function submitUpload(): Promise<void> {
  if (!preparedImage || submitting) return;
  const targetId = Number(recordId.value);
  if (!Number.isSafeInteger(targetId) || targetId < 1) {
    setStatus("Enter a valid ConnectWise record ID", "error");
    return;
  }

  setBusy(true);
  setStatus("Uploading image to ConnectWise…");
  try {
    const targetType = recordType.value as RecordType;
    const upload = await app.callServerTool({
      name: "upload_connectwise_image",
      arguments: {
        recordType: targetType,
        recordId: targetId,
        fileName: preparedImage.fileName,
        mimeType: preparedImage.mimeType,
        base64: preparedImage.base64,
        title: title.value.trim() || preparedImage.fileName,
        privateFlag: visibility.value !== "public",
      },
    });
    if (upload.isError) throw new Error(textResult(upload));
    const documentId = resultId(upload, "document");
    clearPreparedImage();

    let noteId: number | undefined;
    const trimmedNote = noteText.value.trim();
    if (targetType === "Ticket" && trimmedNote) {
      setStatus("Image attached. Creating ticket note…");
      const note = await app.callServerTool({
        name: "create_ticket_note",
        arguments: {
          ticketId: targetId,
          text: trimmedNote,
          internalOnly: internalOnly.checked,
          resolutionNote: resolutionNote.checked,
          issueNote: issueNote.checked,
        },
      });
      if (note.isError) {
        const documentMessage = documentId
          ? " as document " + String(documentId)
          : "";
        throw new Error(
          "Image attached" +
            documentMessage +
            ", but the ticket note failed: " +
            textResult(note),
        );
      }
      noteId = resultId(note, "note");
    }

    let summary =
      "Image attached to " +
      (targetType === "Ticket" ? "ticket " : "time entry ") +
      String(targetId);
    if (documentId) summary += " as document " + String(documentId);
    if (noteId) summary += "; note " + String(noteId) + " created";
    summary += ".";
    setStatus(summary, "success");
    try {
      await app.updateModelContext({
        content: [{ type: "text", text: summary }],
      });
    } catch {
      // The result remains visible if the host omits this optional API.
    }
  } catch (error) {
    setStatus(
      error instanceof Error ? error.message : "ConnectWise upload failed",
      "error",
    );
  } finally {
    setBusy(false);
  }
}

function handleHostContext(context: McpUiHostContext): void {
  if (context.theme) applyDocumentTheme(context.theme);
  if (context.styles?.variables) {
    applyHostStyleVariables(context.styles.variables);
  }
  if (context.safeAreaInsets) {
    appElement.style.paddingTop =
      String(context.safeAreaInsets.top + 22) + "px";
    appElement.style.paddingRight =
      String(context.safeAreaInsets.right + 22) + "px";
    appElement.style.paddingBottom =
      String(context.safeAreaInsets.bottom + 22) + "px";
    appElement.style.paddingLeft =
      String(context.safeAreaInsets.left + 22) + "px";
  }
}

app.ontoolinput = (params) => {
  const input = params.arguments ?? {};
  if (input.recordType === "Ticket" || input.recordType === "TimeEntry") {
    recordType.value = input.recordType;
  }
  if (
    typeof input.recordId === "number" &&
    Number.isSafeInteger(input.recordId) &&
    input.recordId > 0
  ) {
    recordId.value = String(input.recordId);
  }
  syncTarget();
};
app.onhostcontextchanged = handleHostContext;
app.onerror = (error) => {
  setStatus(error.message || "The uploader lost its host connection", "error");
};

syncTarget();
setBusy(false);
app
  .connect()
  .then(() => {
    const context = app.getHostContext();
    if (context) handleHostContext(context);
  })
  .catch((error: unknown) => {
    setStatus(
      error instanceof Error
        ? "The uploader could not connect: " + error.message
        : "The uploader could not connect",
      "error",
    );
  });
