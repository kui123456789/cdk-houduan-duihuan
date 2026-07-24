import { ACCOUNT_ATTEMPT_LIMIT, EMPTY_PREFLIGHT_SUMMARY, WORKSPACE_TABS } from "../config/redeemConstants.js";
import { countStatuses } from "../redeemLogic.js";
import { computeRequestStatusCounts } from "../state/redeemSelectors.js";

function asCount(value) {
  const count = Number(value || 0);
  return Number.isFinite(count) ? count : 0;
}

function getFactCounts(accountFacts) {
  return accountFacts && typeof accountFacts === "object" && accountFacts.counts
    ? accountFacts.counts
    : {};
}

function getPreflightSummary(preflightSummary) {
  return {
    ...EMPTY_PREFLIGHT_SUMMARY,
    ...(preflightSummary && typeof preflightSummary === "object" ? preflightSummary : {})
  };
}

export function buildRedeemViewModel({
  rows = [],
  accountFacts = {},
  cdkeyFacts = {},
  statusCounts,
  groupedStatusCounts,
  counts = {},
  preflightSummary,
  isPolling = false
} = {}) {
  const accountCounts = getFactCounts(accountFacts);
  const resolvedStatusCounts = statusCounts || countStatuses(rows);
  const resolvedGroupedStatusCounts = groupedStatusCounts || computeRequestStatusCounts(resolvedStatusCounts);
  const resolvedPreflightSummary = getPreflightSummary(preflightSummary);
  const hasPreflightSummary = counts.hasPreflightSummary ?? resolvedPreflightSummary.checked > 0;
  const account = {
    pool: asCount(accountCounts.pool ?? counts.accountLineCount),
    available: asCount(accountCounts.available ?? counts.activeAccountLineCount),
    cooling: asCount(accountCounts.cooling ?? counts.cooldownAccountCount),
    attemptLimited: asCount(accountCounts.attemptLimited ?? counts.attemptLimitedAccountCount),
    activeTask: asCount(accountCounts.activeTask ?? counts.activeTaskAccountCount),
    completed: asCount(accountCounts.completed ?? counts.completedAccountCount),
    completedPlus: asCount(accountCounts.completedPlus ?? counts.processedPlusAccountCount),
    estimatedImported: asCount(accountCounts.estimatedImported ?? counts.estimatedImportedAccountCount)
  };
  const cdkeyTotal = asCount(cdkeyFacts.total ?? counts.cdkTotal ?? counts.availableCdkCount);
  const cdkeyUsed = asCount(cdkeyFacts.usedCount ?? cdkeyFacts.used ?? counts.cdkUsedCount);
  const cdkeyUnused = asCount(cdkeyFacts.unusedCount ?? cdkeyFacts.unused ?? counts.cdkUnusedCount ?? cdkeyTotal - cdkeyUsed);
  const cdkeyAvailable = asCount(cdkeyFacts.available ?? counts.availableCdkCount ?? cdkeyUnused);
  const tasks = {
    total: asCount(resolvedStatusCounts.total),
    waiting: asCount(resolvedGroupedStatusCounts.waiting),
    pendingDispatch: asCount(resolvedStatusCounts.pending_dispatch),
    dispatched: asCount(resolvedGroupedStatusCounts.dispatched),
    running: asCount(resolvedGroupedStatusCounts.running),
    failed: asCount(resolvedGroupedStatusCounts.failed),
    cancelled: asCount(resolvedStatusCounts.cancelled),
    timeout: asCount(resolvedStatusCounts.timeout),
    resubmittable: asCount(counts.resubmittableCount),
    cooldownTask: asCount(counts.cooldownTaskCount),
    taskIssues: asCount(resolvedStatusCounts.skipped)
  };
  const prepSummary = {
    accountLineCount: account.pool,
    activeAccountLineCount: account.available,
    cooldownAccountCount: account.cooling,
    attemptLimitedAccountCount: account.attemptLimited,
    activeTaskAccountCount: account.activeTask,
    estimatedImportedAccountCount: account.estimatedImported,
    processedPlusAccountCount: account.completedPlus,
    availableCdkCount: cdkeyAvailable,
    displayedAvailableCdkCount: asCount(
      counts.displayedAvailableCdkCount ?? (hasPreflightSummary ? resolvedPreflightSummary.available : cdkeyAvailable)
    ),
    hasPreflightSummary,
    preflightSummary: resolvedPreflightSummary,
    preflightAttentionCount: asCount(
      counts.preflightAttentionCount ??
        resolvedPreflightSummary.used + resolvedPreflightSummary.busy + resolvedPreflightSummary.unknown
    ),
    displayedRedeemablePairCount: asCount(
      counts.displayedRedeemablePairCount ??
        (hasPreflightSummary ? resolvedPreflightSummary.submitted : Math.min(account.available, cdkeyAvailable))
    ),
    displayedWaitingAccounts: asCount(
      counts.displayedWaitingAccounts ??
        (hasPreflightSummary ? resolvedPreflightSummary.waitingAccounts : Math.max(account.available - cdkeyAvailable, 0))
    ),
    displayedWaitingCdkeys: asCount(
      counts.displayedWaitingCdkeys ??
        (hasPreflightSummary ? resolvedPreflightSummary.waitingCdkeys : Math.max(cdkeyAvailable - account.available, 0))
    ),
    isPolling,
    accountAttemptLimit: asCount(counts.accountAttemptLimit ?? ACCOUNT_ATTEMPT_LIMIT),
    rowsLength: asCount(counts.rowsLength ?? rows.length)
  };
  const cdkey = {
    total: cdkeyTotal,
    used: cdkeyUsed,
    unused: cdkeyUnused,
    available: cdkeyAvailable
  };
  const autoCycleQueueRemaining = asCount(counts.autoCycleQueueRemaining);
  const executeStatusCards = [
    { label: "总任务", value: tasks.total },
    { label: "卡密总数", value: cdkey.total },
    {
      label: "账号池",
      value: account.pool,
      tone: "info",
      title: "当前账号输入池里的有效账号总数"
    },
    {
      label: "可用账号",
      value: account.available,
      tone: account.available ? "info" : "",
      title: `可立即配对提交的账号数；自动换号队列剩余 ${autoCycleQueueRemaining} 个`
    },
    {
      label: "冷却账号",
      value: account.cooling,
      tone: account.cooling ? "warning" : "",
      title: "24 小时封存中，到期后自动恢复兑换队列"
    },
    {
      label: "已达 3/3",
      value: account.attemptLimited,
      tone: account.attemptLimited ? "warning" : "",
      title: "24 小时内已达到 3 次尝试，本地不会提交第 4 次"
    },
    {
      label: "任务占用",
      value: account.activeTask,
      tone: account.activeTask ? "info" : "",
      title: "已有待提交、待兑换、已派发或兑换中的账号"
    },
    {
      label: "已处理账号",
      value: account.completed,
      tone: account.completed ? "success" : "",
      title: "已经成功或被自动换号标记为已处理的账号"
    },
    { label: "等待合计", value: tasks.waiting },
    { label: "待兑换", value: tasks.pendingDispatch, tone: "info" },
    { label: "已派发", value: tasks.dispatched, tone: "info" },
    { label: "兑换中", value: tasks.running, tone: "info" },
    { label: "已使用", value: cdkey.used, tone: "success" },
    { label: "未使用", value: cdkey.unused, tone: "warning" },
    { label: "失败", value: tasks.failed, tone: "danger" },
    { label: "超时", value: tasks.timeout, tone: "warning" },
    { label: "已取消", value: tasks.cancelled, tone: tasks.cancelled ? "warning" : "" },
    { label: "可重兑", value: tasks.resubmittable, tone: tasks.resubmittable ? "info" : "" },
    { label: "跳过", value: tasks.taskIssues, tone: tasks.taskIssues ? "warning" : "" },
    {
      label: "冷却任务",
      value: tasks.cooldownTask,
      tone: tasks.cooldownTask ? "warning" : "",
      title: "当前表格中仍可见的 24 小时封存任务行数"
    }
  ];
  const workspaceMeta = {
    prep: `${account.pool} 账号 · ${cdkeyAvailable} CDK`,
    audit: "独立检测",
    execute: isPolling ? "自动轮询中" : `${tasks.total} 个任务`,
    exports: `${asCount(counts.exportLineCount)} 行可导出`
  };
  const workspaceTabs = WORKSPACE_TABS.map((tab) => ({
    ...tab,
    meta: workspaceMeta[tab.id] || ""
  }));

  return {
    account,
    tasks,
    cdkey,
    prepSummary,
    executeStatusCards,
    workspaceMeta,
    workspaceTabs
  };
}
