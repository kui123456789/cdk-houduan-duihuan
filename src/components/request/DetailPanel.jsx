import { STATUS_META, getPlusExportLine, getSubscriptionLabel, statusLabel } from "../../redeemLogic";

export function DetailPanel({ row, helpers }) {
  if (!row) {
    return (
      <div className="detail-panel empty-detail">
        <span>选中项详情</span>
        <p>选择一条请求后，这里会显示邮箱、CDK、状态和处理信息。</p>
      </div>
    );
  }

  return (
    <div className="detail-panel">
      <div className="section-heading compact">
        <div>
          <h3>选中项详情</h3>
          <p>{row.email || "仅查询 CDK"}</p>
        </div>
        <span
          className={`status-pill compact-status ${(STATUS_META[row.status] || STATUS_META.unknown).tone}`}
          title={row.status}
        >
          {helpers.compactStatus(row.status)}
        </span>
      </div>
      <div className="detail-grid">
        <DetailItem label="邮箱" value={row.email || "-"} />
        <DetailItem label="CDK" value={row.cdkey} />
        <DetailItem label="渠道" value={row.channelLabel || row.channel || "-"} />
        <DetailItem label="尝试次数" value={helpers.formatAttemptNumber(row)} />
        <DetailItem label="来源失败账号" value={row.autoCycleSourceEmail || "-"} />
        <DetailItem label="中文状态" value={statusLabel(row.status)} />
        <DetailItem label="Plus 判断" value={getSubscriptionLabel(row)} />
        <DetailItem label="套餐" value={row.subscriptionPlanType || row.subscriptionPlan || "-"} />
        <DetailItem label="活跃订阅" value={formatActiveSubscription(row.hasActiveSubscription)} />
        <DetailItem label="失败原因" value={helpers.formatFailureReason(row) || "-"} />
        <DetailItem label="订阅原因" value={row.subscriptionReason || "-"} wide />
        <DetailItem label="检查时间" value={formatSubscriptionCheckedAt(row.subscriptionCheckedAt)} />
        <DetailItem label="HTTP 状态" value={row.subscriptionHttpStatus || "-"} />
        <DetailItem label="建议重查" value={row.subscriptionRetryable ? "是" : "否"} />
        <DetailItem label="原始原因" value={row.subscriptionRemoteMessage || "-"} wide />
        <DetailItem label="原时间戳" value={row.timestamp || "-"} />
        <DetailItem label="Plus 时间" value={row.subscriptionTimestamp || "-"} />
        <DetailItem label="导出内容" value={getPlusExportLine(row) || "-"} wide />
      </div>
      <div className="raw-status-block">
        <span>后台原始返回</span>
        <pre>{formatRawStatus(row.rawStatus)}</pre>
      </div>
    </div>
  );
}

function DetailItem({ label, value, wide = false }) {
  return (
    <div className={wide ? "detail-item wide" : "detail-item"}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function formatRawStatus(rawStatus) {
  if (!rawStatus) return "暂无后台原始返回；点击查询状态后更新。";

  try {
    return JSON.stringify(rawStatus, null, 2);
  } catch {
    return String(rawStatus);
  }
}

function formatActiveSubscription(value) {
  if (value === true) return "是";
  if (value === false) return "否";
  return "-";
}

function formatSubscriptionCheckedAt(value) {
  const text = String(value || "").trim();
  if (!text) return "-";
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? text : date.toLocaleString();
}
