import { parseAccounts, parseCdkeyPools } from "./domain/accountParsing.js";
import { createEmptySubscriptionState } from "./domain/subscriptionDiagnostics.js";

export * from "./domain/accountParsing.js";
export * from "./domain/statusMeta.js";
export {
  createEmptySubscriptionState,
  getSubscriptionLabel,
  normalizeSubscriptionError,
  normalizeSubscriptionResult
} from "./domain/subscriptionDiagnostics.js";
export * from "./domain/exportFormatting.js";

export function buildSubmitRows(accountText, cdkeyInput) {
  const { accounts, errors: accountErrors } = parseAccounts(accountText);
  const { cdkeys, errors: cdkeyErrors } = parseCdkeyPools(cdkeyInput);
  const errors = [...accountErrors, ...cdkeyErrors];
  const pairCount = Math.min(accounts.length, cdkeys.length);

  const rows = Array.from({ length: pairCount }, (_, index) =>
    createRedeemRow({
      id: `submit-${index}-${accounts[index].lineNumber}-${cdkeys[index].lineNumber}`,
      index,
      account: accounts[index],
      cdkey: cdkeys[index],
      status: "local_ready"
    })
  );

  for (let index = pairCount; index < accounts.length; index += 1) {
    errors.push({
      lineNumber: accounts[index].lineNumber,
      source: accounts[index].source,
      reason: "缺少对应 CDK，提交时跳过；补充卡密后可继续兑换"
    });
  }

  for (let index = pairCount; index < cdkeys.length; index += 1) {
    errors.push({
      lineNumber: cdkeys[index].lineNumber,
      source: cdkeys[index].cdkey,
      poolId: cdkeys[index].poolId,
      poolLabel: cdkeys[index].poolLabel,
      reason: `${cdkeys[index].poolLabel} 缺少对应账号，提交时跳过；可单独查询状态`
    });
  }

  return { rows, errors, accountCount: accounts.length, cdkeyCount: cdkeys.length };
}

export function buildContinuationSubmitRows(accountText, cdkeyInput, existingRows = [], options = {}) {
  const { accounts, errors: accountErrors } = parseAccounts(accountText);
  const { cdkeys, errors: cdkeyErrors } = parseCdkeyPools(cdkeyInput);
  const errors = [...accountErrors, ...cdkeyErrors];
  const rowOffset = Number.isFinite(options.rowOffset)
    ? Math.max(Number(options.rowOffset), 0)
    : existingRows.length;
  const existingEmails = new Set(
    existingRows
      .map((row) => String(row?.email || "").trim().toLowerCase())
      .filter(Boolean)
  );
  const existingCdkeys = new Set(
    existingRows
      .map((row) => String(row?.cdkey || "").trim())
      .filter(Boolean)
  );
  const availableAccounts = accounts.filter(
    (account) => !existingEmails.has(account.email.toLowerCase())
  );
  const availableCdkeys = cdkeys.filter((cdkey) => !existingCdkeys.has(cdkey.cdkey));
  const pairCount = Math.min(availableAccounts.length, availableCdkeys.length);

  const rows = Array.from({ length: pairCount }, (_, index) =>
    createRedeemRow({
      id: `submit-continue-${rowOffset + index}-${availableAccounts[index].lineNumber}-${availableCdkeys[index].lineNumber}`,
      index: rowOffset + index,
      account: availableAccounts[index],
      cdkey: availableCdkeys[index],
      status: "local_ready"
    })
  );

  for (let index = pairCount; index < availableAccounts.length; index += 1) {
    errors.push({
      lineNumber: availableAccounts[index].lineNumber,
      source: availableAccounts[index].source,
      reason: "缺少对应 CDK，提交时跳过；补充卡密后可继续兑换"
    });
  }

  for (let index = pairCount; index < availableCdkeys.length; index += 1) {
    errors.push({
      lineNumber: availableCdkeys[index].lineNumber,
      source: availableCdkeys[index].cdkey,
      poolId: availableCdkeys[index].poolId,
      poolLabel: availableCdkeys[index].poolLabel,
      reason: `${availableCdkeys[index].poolLabel} 缺少对应账号，提交时跳过；可单独查询状态`
    });
  }

  return {
    rows,
    errors,
    accountCount: accounts.length,
    cdkeyCount: cdkeys.length,
    skippedExistingAccountCount: accounts.length - availableAccounts.length,
    skippedExistingCdkeyCount: cdkeys.length - availableCdkeys.length
  };
}

export function buildQueryRows(accountText, cdkeyInput) {
  const { accounts, errors: accountErrors } = parseAccounts(accountText);
  const { cdkeys, errors: cdkeyErrors } = parseCdkeyPools(cdkeyInput);
  const errors = [...cdkeyErrors];
  const rows = cdkeys.map((cdkey, index) => {
    const account = accounts[index] || null;
    return createRedeemRow({
      id: `query-${index}-${cdkey.lineNumber}`,
      index,
      account,
      cdkey,
      status: "querying"
    });
  });

  if (accountText.trim()) {
    errors.push(...accountErrors);
  }

  return { rows, errors, accountCount: accounts.length, cdkeyCount: cdkeys.length };
}

export function createRedeemRow({ id, index, account, cdkey, status }) {
  return {
    id,
    displayIndex: index + 1,
    accountLineNumber: account?.lineNumber || null,
    cdkeyLineNumber: cdkey.lineNumber,
    channel: cdkey.channel || cdkey.poolId || "",
    channelLabel: cdkey.channelLabel || cdkey.poolLabel || "",
    email: account?.email || "",
    password: account?.password || "",
    twofa: account?.twofa || "",
    accessToken: account?.accessToken || "",
    timestamp: account?.timestamp || "",
    exportLine: account?.exportLine || "",
    cdkey: cdkey.cdkey,
    originalCdkey: cdkey.cdkey,
    status,
    reason: "",
    can_cancel: false,
    can_retry: false,
    can_reuse_token: false,
    has_access_token: Boolean(account?.accessToken),
    ...createEmptySubscriptionState(),
    selected: false,
    retryRequestedAt: 0,
    retryHoldUntil: 0,
    staleStatusGuard: false,
    staleStatusGuardStartedAt: 0,
    attemptRound: 1,
    attemptNumber: 1,
    parentRowId: "",
    autoCycle: false,
    autoCycleSourceEmail: "",
    autoCycleHandled: false,
    autoCycleNextRowId: "",
    statusLocked: false,
    statusOwner: false,
    accountAttemptNumber: 1,
    rawStatus: null
  };
}
