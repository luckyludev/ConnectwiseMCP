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
};

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

  return {
    async getServiceTicket(ticketId: number): Promise<unknown> {
      if (!Number.isSafeInteger(ticketId) || ticketId <= 0) {
        throw new Error("Invalid service ticket ID");
      }
      const transientStatuses = new Set([429, 502, 503, 504]);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        let response: Response;
        try {
          response = await fetcher(
            `${credentials.apiBaseUrl}/service/tickets/${ticketId}`,
            {
              method: "GET",
              redirect: "error",
              headers: {
                Accept: "application/json",
                Authorization: `Basic ${authorization}`,
                clientId: credentials.clientId,
              },
              signal: AbortSignal.timeout(timeoutMs),
            },
          );
        } catch {
          if (attempt === 0) {
            await sleep(100);
            continue;
          }
          throw new Error("ConnectWise request unavailable");
        }
        if (transientStatuses.has(response.status) && attempt === 0) {
          await cancelResponseBody(response);
          await sleep(100);
          continue;
        }
        if (!response.ok) {
          await cancelResponseBody(response);
          throw new Error(`ConnectWise request failed (${response.status})`);
        }
        const responseText = await readBoundedResponse(response);
        try {
          return JSON.parse(responseText) as unknown;
        } catch {
          throw new Error("Invalid ConnectWise response");
        }
      }
      throw new Error("ConnectWise request unavailable");
    },
  };
}
