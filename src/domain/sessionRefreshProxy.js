import { readLimitedResponseText } from "./responseBody.js";

const DEFAULT_CONFIG = {
  subscriptionApiBaseUrl: "https://cha.nerver.cc",
  requestTimeoutMs: 45_000,
  maxUpstreamResponseBytes: 5_000_000,
  sessionRefreshAuthToken: ""
};

function sessionRefreshError(message, status = 400, payload = null) {
  const error = new Error(message);
  error.status = status;
  error.payload = payload;
  return error;
}

export async function forwardSessionRefresh(input, { fetchImpl = fetch, config = {} } = {}) {
  const resolvedConfig = { ...DEFAULT_CONFIG, ...config };
  const sessionToken = String(input?.sessionToken || "").trim();
  const cookie = String(input?.cookie || "").trim();
  const session = input?.session && typeof input.session === "object" ? input.session : null;
  if (!sessionToken && !cookie && !session) {
    throw sessionRefreshError("缺少 sessionToken、Cookie 或 Session JSON");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), resolvedConfig.requestTimeoutMs);
  try {
    const response = await fetchImpl(
      `${resolvedConfig.subscriptionApiBaseUrl}/api/v1/session/refresh`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...(resolvedConfig.sessionRefreshAuthToken
            ? { Authorization: `Bearer ${resolvedConfig.sessionRefreshAuthToken}` }
            : {})
        },
        body: JSON.stringify(session || (sessionToken ? { sessionToken } : { cookie })),
        signal: controller.signal
      }
    );
    const rawText = await readLimitedResponseText(
      response,
      resolvedConfig.maxUpstreamResponseBytes
    );
    let payload = {};
    try {
      payload = rawText ? JSON.parse(rawText) : {};
    } catch {
      payload = { ok: false, reason: "bad-response", message: "Session 刷新接口返回内容无法识别" };
    }

    if (!response.ok || payload?.ok !== true || !String(payload?.accessToken || "").trim()) {
      const status =
        response.status === 429 || payload?.reason === "rate-limited"
          ? 429
          : response.ok
            ? 400
            : response.status;
      throw sessionRefreshError(
        String(payload?.message || payload?.error || payload?.reason || "Session 刷新失败"),
        status,
        payload
      );
    }
    return payload;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw sessionRefreshError("Session 刷新接口请求超时", 504);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
