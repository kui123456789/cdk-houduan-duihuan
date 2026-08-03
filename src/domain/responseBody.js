export async function readLimitedResponseText(
  response,
  maxBytes,
  { message = "上游响应内容过大", code = "UPSTREAM_RESPONSE_TOO_LARGE" } = {}
) {
  const byteLimit = Math.max(1, Number(maxBytes || 0));
  const createLimitError = () => {
    const error = new Error(message);
    error.code = code;
    error.status = 502;
    return error;
  };
  const contentLength = Number(response?.headers?.get?.("content-length") || 0);
  if (contentLength > byteLimit) throw createLimitError();

  if (!response?.body?.getReader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > byteLimit) throw createLimitError();
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > byteLimit) {
      await reader.cancel();
      throw createLimitError();
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}
