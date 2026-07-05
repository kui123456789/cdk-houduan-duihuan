export const STORAGE_KEYS = {
  apiKey: "cdkRedeem.apiKey",
  accountText: "cdkRedeem.accountText",
  cdkeyPools: "cdkRedeem.cdkeyPools",
  rows: "cdkRedeem.rows",
  errors: "cdkRedeem.errors",
  accountNotice: "cdkRedeem.accountNotice",
  statusMessage: "cdkRedeem.statusMessage",
  lastUpdatedAt: "cdkRedeem.lastUpdatedAt",
  plusExports: "cdkRedeem.plusExports",
  downloadedExportCounts: "cdkRedeem.downloadedExportCounts",
  autoCycleState: "cdkRedeem.autoCycleState",
  failedAccounts: "cdkRedeem.failedAccounts",
  accountCooldowns: "cdkRedeem.accountCooldowns",
  accountAttemptLedger: "cdkRedeem.accountAttemptLedger",
  uiSettings: "cdkRedeem.uiSettings",
  workflowSnapshot: "cdkRedeem.workflowSnapshot.v1",
  sensitivePersistencePolicy: "cdkRedeem.sensitivePersistencePolicy"
};

export const SAMPLE_ACCOUNT = [
  "mail1@example.com---https://mail.example/inbox/code---at---2026-07-03 15:43:17",
  "mail2@example.com---password---2fa---https://mail.example/inbox/code---at---2026-07-03 15:43:17",
  "mail3@example.com---password---PASSKEY:xxx---https://mail.example/inbox/code---at---2026-07-03 15:43:17",
  "mail4@example.com---https://mail.example/inbox/code---at",
  "mail5@example.com---at"
].join("\n");
export const POLL_INTERVAL_MS = 5000;
export const AUTO_CYCLE_SCHEDULE_DELAY_MS = 1000;
export const RETRY_STATUS_HOLD_MS = 60 * 1000;
export const RETRY_STATUS_HOLD_REASON = "重试已发送，等待后台更新";
export const SUBMIT_STATUS_HOLD_REASON = "重新提交已发送，等待后台更新";
export const ACCOUNT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
export const ACCOUNT_ATTEMPT_WINDOW_MS = ACCOUNT_COOLDOWN_MS;
export const ACCOUNT_ATTEMPT_LIMIT = 3;
export const AUTO_CYCLE_MAX_ROUNDS = 3;
export const DAILY_LIMIT_DISPLAY_REASON = "该账号今日提交次数已达上限，已封存 24 小时";
export const LOCAL_ATTEMPT_LIMIT_REASON = "该账号 24 小时内已提交 3 次，已封存 24 小时，避免触发后台限制";

export const DEFAULT_WORKSPACE_TAB = "prep";
export const WORKSPACE_TABS = [
  { id: "prep", title: "准备输入", subtitle: "API Key / 账号 / CDK" },
  { id: "execute", title: "执行监控", subtitle: "兑换任务 / 请求状态" },
  { id: "exports", title: "结果导出", subtitle: "成功池" }
];

export const DEFAULT_UI_SETTINGS = {
  activeDetailRowId: "",
  activeWorkspaceTab: DEFAULT_WORKSPACE_TAB,
  pollingEnabled: false,
  showApiKey: false
};

export const EMPTY_PREFLIGHT_SUMMARY = {
  checked: 0,
  available: 0,
  used: 0,
  busy: 0,
  unknown: 0,
  waitingAccounts: 0,
  waitingCdkeys: 0,
  submitted: 0,
  skipped: 0
};

export const ACTIVE_BACKEND_STATUSES = new Set([
  "queued",
  "submitted",
  "pending_dispatch",
  "dispatching",
  "dispatched",
  "running",
  "processing"
]);

export const RESUBMIT_REDEEM_STATUSES = new Set([
  "cancelled",
  "failed",
  "timeout",
  "rejected",
  "invalid",
  "approve_blocked",
  "awaiting_payment_expiry"
]);

export const ATTEMPT_FAILURE_STATUSES = new Set([
  "failed",
  "timeout",
  "rejected",
  "invalid",
  "approve_blocked",
  "awaiting_payment_expiry"
]);

export const DAILY_LIMIT_REDEEM_STATUSES = new Set(["failed", "rejected", "cancelled"]);
