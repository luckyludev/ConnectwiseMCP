export const MAX_MCP_REQUEST_BYTES = 16 * 1024 * 1024;
const MAX_MCP_REQUEST_CHUNKS = 4096;

function errorResponse(status: 400 | 413, message: string): Response {
  return new Response(message, {
    status,
    headers: {
      "cache-control": "no-store",
      pragma: "no-cache",
    },
  });
}

export async function prepareMcpRequest(
  request: Request,
): Promise<Request | Response> {
  if (request.method !== "POST") return request;

  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength)) {
      return errorResponse(400, "Invalid request length");
    }
    const parsedLength = Number(declaredLength);
    if (
      !Number.isSafeInteger(parsedLength) ||
      parsedLength > MAX_MCP_REQUEST_BYTES
    ) {
      return errorResponse(413, "Request body too large");
    }
  }

  const reader = request.body?.getReader();
  if (!reader) return request;

  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let chunkCount = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunkCount += 1;
      if (
        chunkCount > MAX_MCP_REQUEST_CHUNKS ||
        byteLength + value.byteLength > MAX_MCP_REQUEST_BYTES
      ) {
        await reader.cancel().catch(() => undefined);
        return errorResponse(413, "Request body too large");
      }
      if (value.byteLength === 0) continue;
      byteLength += value.byteLength;
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return errorResponse(400, "Invalid request body");
  }

  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const headers = new Headers(request.headers);
  headers.set("content-length", String(byteLength));
  return new Request(request, { headers, body: body.buffer });
}
