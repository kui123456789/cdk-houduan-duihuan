import { FileSearch, Loader2, Play, RotateCcw, Trash2, Unlock, XCircle } from "lucide-react";
import { StatusCard } from "../common/StatusCard";

export function ExecutionControlPanel({
  isBusy,
  failedRetryRowCount,
  cooldownAccountCount,
  plusAccountRowCount,
  submitVerified,
  securityControl,
  stats,
  onSubmit,
  onQuery,
  onCancelSelected,
  onRetryFailed,
  onRestoreCooldowns,
  onDeletePlus,
  onClear
}) {
  return (
    <section className="execute-band" aria-label="执行">
      <div className="command-cluster">
        <div className="submit-security-control">{securityControl}</div>
        <button
          className="primary-button"
          onClick={onSubmit}
          disabled={isBusy || !submitVerified}
          title={submitVerified ? "开始兑换" : "等待安全验证通过"}
        >
          {isBusy ? <Loader2 size={16} className="spin" /> : <Play size={16} />}
          开始兑换
        </button>
        <button className="secondary-button" onClick={onQuery} disabled={isBusy}>
          <FileSearch size={16} />
          查询状态
        </button>
        <button className="secondary-button" onClick={onCancelSelected} disabled={isBusy}>
          <XCircle size={16} />
          批量取消
        </button>
        <button
          className="secondary-button retry-failed-action"
          onClick={onRetryFailed}
          disabled={isBusy || !failedRetryRowCount}
          title={
            failedRetryRowCount
              ? `一键重试 ${failedRetryRowCount} 条失败/超时任务，不含账号风控`
              : "没有可一键重试的失败任务"
          }
        >
          <RotateCcw size={16} />
          一键重试失败
        </button>
        <button
          className="secondary-button restore-cooldown-action"
          onClick={onRestoreCooldowns}
          disabled={isBusy || !cooldownAccountCount}
          title={
            cooldownAccountCount
              ? `恢复 ${cooldownAccountCount} 个本地冷却/达上限账号`
              : "没有可恢复的冷却账号"
          }
        >
          <Unlock size={16} />
          一键恢复冷却
        </button>
        <button
          className="secondary-button plus-delete-action"
          onClick={onDeletePlus}
          disabled={isBusy || !plusAccountRowCount}
          title={
            plusAccountRowCount
              ? `删除 ${plusAccountRowCount} 个已通过 Plus 和邮箱验证的账号`
              : "没有已通过 Plus 和邮箱验证的账号"
          }
        >
          <Trash2 size={15} />
          删除已验证
        </button>
        <button className="secondary-button danger-action" onClick={onClear} disabled={isBusy}>
          <Trash2 size={15} />
          一键清理
        </button>
      </div>
      <div className="status-strip" aria-live="polite">
        {stats.map((item, index) => (
          <StatusCard
            key={`${item.label}-${index}`}
            label={item.label}
            value={item.value}
            tone={item.tone}
            title={item.title}
          />
        ))}
      </div>
    </section>
  );
}
