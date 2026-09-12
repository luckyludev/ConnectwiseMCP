export const MAX_OAUTH_TOKEN_REQUEST_BYTES = 16 * 1024;
const MAX_OAUTH_TOKEN_REQUEST_CHUNKS = 256;

type TokenRequestError = {
  status: 400 | 413;
  description: string;
};

function errorResponse(
  { status, description }: TokenRequestError,
  request: Request,
): Response {
  const headers = new Headers({
    "cache-control": "no-store",
    pragma: "no-cache",
  });
  const origin = request.headers.get("origin");
  if (origin) {
    headers.set("access-control-allow-origin", origin);
    headers.set("access-control-allow-methods", "*");
    headers.set("access-control-allow-headers", "Authorization, *");
    headers.set("access-control-max-age", "86400");
  }
  return Response.json(
    { error: "invalid_request", error_description: description },
    { status, headers },
  );
}

export async function prepareOAuthTokenRequest(
  request: Request,
): Promise<Request | Response> {
  if (request.method !== "POST") return request;

  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength)) {
      return errorResponse(
        {
          status: 400,
          description: "Invalid request length",
        },
        request,
      );
    }
    const parsedLength = Number(declaredLength);
    if (
      !Number.isSafeInteger(parsedLength) ||
      parsedLength > MAX_OAUTH_TOKEN_REQUEST_BYTES
    ) {
      return errorResponse(
        {
          status: 413,
          description: "Request body too large",
        },
        request,
      );
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
        chunkCount > MAX_OAUTH_TOKEN_REQUEST_CHUNKS ||
        byteLength + value.byteLength > MAX_OAUTH_TOKEN_REQUEST_BYTES
      ) {
        await reader.cancel().catch(() => undefined);
        return errorResponse(
          {
            status: 413,
            description: "Request body too large",
          },
          request,
        );
      }
      if (value.byteLength === 0) continue;
      byteLength += value.byteLength;
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return errorResponse(
      {
        status: 400,
        description: "Invalid request body",
      },
      request,
    );
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
