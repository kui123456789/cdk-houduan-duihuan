import { Clock3, RefreshCw, Ticket, TriangleAlert } from "lucide-react";

const BASE_CARDS = [
  { key: "vip", label: "VIP 通道", icon: Ticket, tone: "vip" },
  { key: "ideal", label: "IDEAL 排队", icon: Clock3, tone: "ideal" },
  { key: "upi", label: "UPI 排队", icon: Clock3, tone: "upi" },
  { key: "pix", label: "PIX 排队", icon: Clock3, tone: "pix" },
  { key: "kakao", label: "KAKAO 排队", icon: Clock3, tone: "kakao" }
];

function formatCheckedAt(value) {
  if (!value) return "等待首次更新";
  return `更新于 ${new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
}

export function QueueSummaryPanel({ summary, status, error, checkedAt, onRefresh }) {
  const cards = summary.normal > 0
    ? [{ key: "normal", label: "普通排队", icon: Clock3, tone: "normal" }, ...BASE_CARDS]
    : BASE_CARDS;

  return (
    <section className="queue-summary-panel" aria-label="兑换后台队列">
      <div className="queue-summary-header">
        <div>
          <h2>兑换后台队列</h2>
          <p>仅统计已提交 access_token、正在等待系统接单的兑换任务</p>
        </div>
        <div className="queue-summary-tools">
          <span className={`queue-summary-state ${status}`}>
            {status === "error" ? "更新失败" : formatCheckedAt(checkedAt)}
          </span>
          <button
            type="button"
            className="ghost-button small queue-summary-refresh"
            onClick={onRefresh}
            disabled={status === "loading"}
            title="刷新兑换后台队列"
          >
            <RefreshCw size={15} className={status === "loading" ? "spin" : ""} />
            刷新
          </button>
        </div>
      </div>

      <div className={`queue-summary-grid ${cards.length === 6 ? "has-normal" : ""}`}>
        {cards.map(({ key, label, icon: Icon, tone }) => (
          <div key={key} className={`queue-summary-card ${tone}`}>
            <div className="queue-summary-card-heading">
              <span>{label}</span>
              <Icon size={28} strokeWidth={1.8} aria-hidden="true" />
            </div>
            <strong>{status === "loading" && !checkedAt ? "--" : summary[key]}</strong>
          </div>
        ))}
      </div>

      <div className={`queue-summary-note ${status === "error" ? "error" : ""}`} role={status === "error" ? "alert" : undefined}>
        {status === "error" ? <TriangleAlert size={15} aria-hidden="true" /> : null}
        <span>{error || "队列数据每 5 秒自动刷新"}</span>
      </div>
    </section>
  );
}
