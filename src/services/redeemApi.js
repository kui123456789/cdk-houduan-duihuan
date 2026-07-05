export function createRedeemApi({ getApiKey, fetchImpl = fetch }) {
  async function postJson(path, body) {
    const response = await fetchImpl(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const payload = await response.json().catch(() => ({}));
    return { response, payload };
  }

  async function callJson(path, body) {
    const { response, payload } = await postJson(path, body);
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.message || payload.error || `请求失败：${response.status}`);
    }
    return payload;
  }

  async function callProxy(path, body) {
    const apiKey = String(getApiKey() || "").trim();
    if (!apiKey) {
      throw new Error("请先填写外部 API Key");
    }

    return callJson(path, {
      apiKey,
      ...body
    });
  }

  async function checkSubscription(token) {
    let result;
    try {
      result = await postJson("/api/subscription/check", { token });
    } catch (error) {
      const wrapped = new Error(error.message || "无法连接订阅检查代理");
      wrapped.subscriptionDiagnostic = {
        category: "network_error",
        title: "网络错误",
        message: "浏览器无法连接本地订阅检查代理，可点击查Plus重试",
        retryable: true,
        remoteMessage: error.message || ""
      };
      throw wrapped;
    }

    const { response, payload } = result;
    if (!response.ok) {
      if (payload?.diagnostic || payload?.category) {
        return payload;
      }
      const error = new Error(payload.error || "订阅检查失败");
      error.subscriptionDiagnostic = {
        category: "unknown",
        title: "未知",
        message: payload.error || "订阅检查失败",
        retryable: true,
        httpStatus: response.status
      };
      throw error;
    }
    return payload;
  }

  return {
    callProxy,
    submitRedeems: (items) => callProxy("/api/redeem/submit", { items }),
    queryStatuses: (cdkeys) => callProxy("/api/redeem/status", { cdkeys }),
    cancelJobs: (cdkeys) => callProxy("/api/redeem/cancel", { cdkeys }),
    retryJobs: (cdkeys) => callProxy("/api/redeem/retry", { cdkeys }),
    checkSubscription
  };
}
