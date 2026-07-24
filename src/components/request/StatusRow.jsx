import {
  STATUS_META,
  getEmailVerificationLabel,
  getSubscriptionLabel,
  statusLabel
} from "../../redeemLogic";
import { RowProgress } from "./RowProgress";

export function StatusRow({
  row,
  onSelect,
  onViewDetail,
  onCancel,
  onRetry,
  onRecheckPlus,
  onDelete,
  active,
  busy,
  helpers
}) {
  const meta = STATUS_META[row.status] || STATUS_META.unknown;
  const isHistoryRow = helpers.isHistoricalAutoCycleRow(row);
  const canCancel = helpers.canCancelRow(row);
  const canRetry = helpers.canRetryVisibleRow(row);
  const canResubmit = helpers.canResubmitRedeemRow(row);
  const canRetryOrResubmit = canRetry || canResubmit;
  const canRecheckPlus = helpers.canRecheckSubscriptionRow(row);
  const retryLabel = canRetry ? "重试" : canResubmit ? "重新兑换" : "重试";
  const canDelete = Boolean(row.id);
  const rowNumber = row.accountLineNumber || row.cdkeyLineNumber || "-";
  const rowLabel = row.email || row.cdkey || "仅查询 CDK";

  return (
    <tr className={active ? "active-row" : ""}>
      <td>
        <input
          type="checkbox"
          checked={row.selected}
          onChange={onSelect}
          aria-label={`选择第 ${rowNumber} 行 ${rowLabel}`}
        />
      </td>
      <td>{rowNumber}</td>
      <td className="mono muted-cell">
        <button type="button" className="account-link" onClick={onViewDetail}>
          {row.email || "仅查询 CDK"}
        </button>
      </td>
      <td className="progress-cell">
        <RowProgress row={row} getProgress={helpers.getRowRedeemProgress} />
      </td>
      <td className="mono">{row.cdkey}</td>
      <td>
        <span className={`channel-pill ${row.channel || "default"}`}>
          {row.channelLabel || row.channel || "-"}
        </span>
      </td>
      <td className="nowrap-cell">{helpers.formatAttemptNumber(row)}</td>
      <td>
        <span className={`status-pill compact-status ${meta.tone}`} title={row.status}>
          {isHistoryRow ? "历史" : helpers.compactStatus(row.status)}
        </span>
      </td>
      <td className="nowrap-cell">{isHistoryRow ? "已换号/历史" : statusLabel(row.status)}</td>
      <td>
        <span className={`status-pill ${helpers.getSubscriptionTone(row)}`}>
          {getSubscriptionLabel(row)}
        </span>
      </td>
      <td>
        <span className={`status-pill ${helpers.getEmailVerificationTone(row)}`}>
          {getEmailVerificationLabel(row)}
        </span>
      </td>
      <td className="reason-cell subscription-reason-cell">{row.subscriptionReason || "-"}</td>
      <td className="reason-cell">{helpers.formatFailureReason(row) || "-"}</td>
      <td>{canCancel ? "是" : "否"}</td>
      <td>{canRetry ? "是" : canResubmit ? "可重兑" : "否"}</td>
      <td>
        <div className="row-actions">
          <button type="button" onClick={onCancel} disabled={busy || !canCancel} title="取消任务">
            取消
          </button>
          <button
            type="button"
            onClick={onRetry}
            disabled={busy || !canRetryOrResubmit}
            title={canResubmit && !canRetry ? "重新提交该账号和 CDK" : "重试任务"}
          >
            {retryLabel}
          </button>
          <button
            type="button"
            onClick={onRecheckPlus}
            disabled={busy || !canRecheckPlus}
            title="重新检查该账号的 Plus 状态和邮箱开通通知"
          >
            查验证
          </button>
          <button type="button" onClick={onDelete} disabled={busy || !canDelete} title="删除该请求">
            删除
          </button>
        </div>
      </td>
    </tr>
  );
}
