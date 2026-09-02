export const MAX_SMOKE_RESPONSE_BYTES = 256 * 1024;

export async function readBoundedText(
  response,
  maxBytes = MAX_SMOKE_RESPONSE_BYTES,
) {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    Number.isFinite(Number(declaredLength)) &&
    Number(declaredLength) > maxBytes
  ) {
    await response.body?.cancel();
    throw new Error("response_too_large");
  }

  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("response_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function readBoundedJson(response, fallback) {
  const text = await readBoundedText(response);
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}
