import { jobsToProxyPayload } from "./jobApi.js";

export function createRedeemApi({
  getApiKey,
  fetchImpl = fetch,
  jobModeEnabled = false,
  jobApi = null
}) {
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
    if ((!response.ok || payload.ok === false) && payload.partial !== true) {
      throw new Error(payload.message || payload.error || `请求失败：${response.status}`);
    }
    return payload;
  }

  async function callProxy(path, body, options = {}) {
    const apiKey = String(getApiKey() || "").trim();
    const credentialMode = String(options.credentialMode || "").trim();
    const credentialBody = {
      ...(apiKey ? { apiKey } : {}),
      ...(credentialMode ? { credentialMode } : {}),
      ...body
    };

    if (jobModeEnabled && jobApi) {
      if (path === "/api/redeem/submit") {
        if (!apiKey && credentialMode !== "session") throw new Error("请先填写外部 API Key");
        return jobsToProxyPayload([await jobApi.createJob(credentialBody)]);
      }
      if (path === "/api/redeem/status") {
        const cdkeys = Array.isArray(body?.cdkeys) ? body.cdkeys : [];
        const jobs = await jobApi.listJobs();
        const jobPayload = jobsToProxyPayload(jobs, cdkeys);
        const found = new Set(jobPayload.items.map((item) => item.cdkey));
        const missingCdkeys = cdkeys.filter((cdkey) => !found.has(String(cdkey || "").trim()));
        if (!missingCdkeys.length || (!apiKey && credentialMode !== "session")) return jobPayload;
        const legacy = await callJson(path, { ...credentialBody, cdkeys: missingCdkeys });
        return {
          ...legacy,
          ok: true,
          items: [...jobPayload.items, ...(legacy.items || [])],
          jobs,
          batchCount: jobPayload.batchCount + Number(legacy.batchCount || 0)
        };
      }
      if (path === "/api/redeem/cancel" || path === "/api/redeem/retry") {
        const cdkeys = Array.isArray(body?.cdkeys) ? body.cdkeys : [];
        const jobs = path.endsWith("/cancel")
          ? await jobApi.cancelByCdkeys(cdkeys)
          : await jobApi.retryByCdkeys(cdkeys);
        return jobsToProxyPayload(jobs, cdkeys);
      }
    }

    if (!apiKey && credentialMode !== "session") {
      throw new Error("请先填写外部 API Key");
    }

    return callJson(path, credentialBody);
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
        message: "浏览器无法连接本地订阅检查代理，可点击查验证重试",
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

  async function checkPlusEmail(pickupUrl, redeemedAt = "") {
    let result;
    try {
      result = await postJson("/api/subscription/email-check", { pickupUrl, redeemedAt });
    } catch (error) {
      const wrapped = new Error(error.message || "无法连接邮箱验证代理");
      wrapped.emailVerificationDiagnostic = {
        category: "network_error",
        title: "网络错误",
        message: "浏览器无法连接邮箱验证代理，可重试",
        retryable: true,
        remoteMessage: error.message || ""
      };
      throw wrapped;
    }

    const { response, payload } = result;
    if (!response.ok) {
      if (payload?.diagnostic || payload?.emailVerification || payload?.category) return payload;
      const error = new Error(payload.error || "邮箱 Plus 验证失败");
      error.emailVerificationDiagnostic = {
        category: "unknown",
        title: "未知",
        message: payload.error || "邮箱 Plus 验证失败",
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
    checkSubscription,
    checkPlusEmail
  };
}
