export class ResponseBodyTooLargeError extends Error {
  constructor(maxBytes) {
    super(`上游响应体超过 ${maxBytes} 字节限制`);
    this.name = "ResponseBodyTooLargeError";
    this.code = "UPSTREAM_RESPONSE_TOO_LARGE";
    this.status = 502;
    this.maxBytes = maxBytes;
  }
}

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException("The operation was aborted", "AbortError");
}

export async function readTextWithLimit(
  response,
  { maxBytes, signal, abortController } = {}
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError("maxBytes must be a positive safe integer");
  }

  const reader = response?.body?.getReader?.();
  if (!reader) return "";

  let aborted = false;
  let rejectAbort;
  const abortPromise = new Promise((_, reject) => {
    rejectAbort = reject;
  });
  void abortPromise.catch(() => {});
  const handleAbort = () => {
    aborted = true;
    const error = abortError(signal);
    rejectAbort(error);
    void reader.cancel(error).catch(() => {});
  };
  signal?.addEventListener("abort", handleAbort, { once: true });

  try {
    if (signal?.aborted) throw abortError(signal);

    const declaredLength = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      const error = new ResponseBodyTooLargeError(maxBytes);
      abortController?.abort(error);
      await reader.cancel(error).catch(() => {});
      throw error;
    }

    const decoder = new TextDecoder();
    const parts = [];
    let totalBytes = 0;
    while (true) {
      const readPromise = reader.read();
      const { done, value } = signal
        ? await Promise.race([readPromise, abortPromise])
        : await readPromise;
      if (done) break;

      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      totalBytes += bytes.byteLength;
      if (totalBytes > maxBytes) {
        const error = new ResponseBodyTooLargeError(maxBytes);
        abortController?.abort(error);
        await reader.cancel(error).catch(() => {});
        throw error;
      }
      parts.push(decoder.decode(bytes, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join("");
  } finally {
    signal?.removeEventListener("abort", handleAbort);
    if (!aborted) reader.releaseLock();
  }
}
