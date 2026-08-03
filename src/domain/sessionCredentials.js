import { updateAccountSourceSessionToken } from "./accountParsing.js";

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function buildRefreshedSession(account, payload, accessToken, sessionToken) {
  const payloadSession = payload?.session && typeof payload.session === "object" && !Array.isArray(payload.session)
    ? payload.session
    : null;
  const accountSession = account?.session && typeof account.session === "object" && !Array.isArray(account.session)
    ? account.session
    : null;
  const baseSession = payloadSession || accountSession || {};
  const email = normalizeEmail(payload?.email || account?.email);
  const expires = String(payload?.expires || baseSession?.expires || "").trim();
  return {
    ...baseSession,
    ...(email
      ? { user: { ...(baseSession?.user && typeof baseSession.user === "object" ? baseSession.user : {}), email } }
      : {}),
    accessToken,
    access_token: accessToken,
    ...(sessionToken ? { sessionToken } : {}),
    ...(expires ? { expires } : {})
  };
}

export function isSessionCredential(value) {
  return value?.credentialKind === "session_token" || Boolean(value?.sessionToken);
}

export async function refreshSessionCredential(account, options = {}) {
  if (!isSessionCredential(account)) return { account, payload: null };
  const sessionToken = String(account?.sessionToken || account?.credentialValue || "").trim();
  if (!sessionToken) throw new Error("账号中缺少 sessionToken");
  if (typeof options.refreshSession !== "function") {
    throw new Error("Session 刷新接口不可用");
  }

  const payload = await options.refreshSession(sessionToken);
  const accessToken = String(payload?.accessToken || "").trim();
  if (!accessToken) throw new Error("Session 刷新结果没有 accessToken");
  const expectedEmail = normalizeEmail(account?.email);
  const returnedEmail = normalizeEmail(payload?.email);
  if (returnedEmail && returnedEmail !== expectedEmail) {
    const error = new Error(`刷新结果邮箱 ${returnedEmail} 与账号邮箱不一致`);
    error.sessionRefreshPermanent = true;
    throw error;
  }

  const nextSessionToken = String(payload?.sessionToken || sessionToken).trim();
  const session = buildRefreshedSession(account, payload, accessToken, nextSessionToken);
  const refreshedAt = new Date().toISOString();
  const stage = String(options.stage || "pre_submit").trim();
  return {
    account: {
      ...account,
      accessToken,
      refreshedAccessToken: accessToken,
      sessionToken: nextSessionToken,
      session,
      credentialKind: "session_token",
      credentialValue: nextSessionToken,
      sourceType: "session",
      source: updateAccountSourceSessionToken(account?.source, nextSessionToken),
      sessionRefreshStatus: "success",
      sessionRefreshStage: stage,
      sessionRefreshReason:
        stage === "post_success" ? "兑换成功后已刷新 AT" : "提交前已刷新 AT",
      sessionRefreshRetryable: false,
      sessionRefreshedAt: refreshedAt,
      sessionExpires: String(payload?.expires || "").trim(),
      sessionRotated: payload?.session_rotated === true
    },
    payload: {
      ...payload,
      accessToken,
      sessionToken: nextSessionToken,
      session
    }
  };
}

export function isReleaseVerifiedAccount(row) {
  if (
    row?.status !== "success" ||
    row?.emailBanned === true ||
    !String(row?.email || "").trim() ||
    !String(row?.redemptionTimestamp || "").trim()
  ) {
    return false;
  }
  const hasPickupUrl = Boolean(String(row?.pickupUrl || "").trim());
  if (hasPickupUrl) {
    if (row?.emailPlusVerified !== true) return false;
    if (!isSessionCredential(row)) return true;
    return row?.sessionRefreshStatus === "success";
  }
  if (row?.subscriptionStatus !== "plus" || row?.isPlus !== true) return false;
  return !isSessionCredential(row) || row?.sessionRefreshStatus === "success";
}

export async function refreshSessionCredentialAccounts(accounts, options = {}) {
  const list = Array.isArray(accounts) ? accounts : [];
  const refreshSession = options.refreshSession;
  const concurrency = Math.max(1, Number(options.concurrency || 3));
  const results = new Array(list.length);
  let completed = 0;

  for (let offset = 0; offset < list.length; offset += concurrency) {
    const batch = list.slice(offset, offset + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (account) => {
        if (!isSessionCredential(account)) return { ok: true, account };
        try {
          const refreshed = await refreshSessionCredential(account, {
            refreshSession,
            stage: options.stage || "pre_submit"
          });
          return {
            ok: true,
            account: refreshed.account,
            payload: refreshed.payload
          };
        } catch (error) {
          return { ok: false, account, error };
        }
      })
    );

    batchResults.forEach((result, index) => {
      results[offset + index] = result;
      completed += 1;
      options.onProgress?.(completed, list.length);
    });
  }

  const successfulAccounts = [];
  const errors = [];
  const refreshedByEmail = new Map();
  results.forEach((result) => {
    if (result?.ok) {
      successfulAccounts.push(result.account);
      if (isSessionCredential(result.account)) {
        refreshedByEmail.set(normalizeEmail(result.account.email), result.account);
      }
      return;
    }
    errors.push({
      lineNumber: result?.account?.lineNumber,
      source: result?.account?.source || result?.account?.email || "",
      type: "session_refresh",
      reason: result?.error?.message || "Session 刷新失败"
    });
  });

  return { accounts: successfulAccounts, errors, refreshedByEmail, results };
}
