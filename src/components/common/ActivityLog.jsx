import { formatActivityLogMessage } from "../../workflow/activityLog";
import { buildActivityLogEntries } from "./activityLogEntries";

function formatTime(createdAt, fallback = "") {
  const timestamp = Number(createdAt);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return fallback || "尚未更新";

  try {
    return new Intl.DateTimeFormat("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).format(new Date(timestamp));
  } catch {
    return fallback || "尚未更新";
  }
}

export function ActivityLog({
  entries = [],
  errors = [],
  statusMessage = "",
  lastUpdatedAt = ""
}) {
  const visibleEntries = buildActivityLogEntries({
    entries,
    errors,
    statusMessage,
    lastUpdatedAt
  });
  const warningCount = visibleEntries.filter((entry) =>
    ["warning", "error"].includes(entry?.level)
  ).length;

  return (
    <section className="activity-log-card" aria-label="日志">
      <div className="section-heading compact">
        <div>
          <h2>日志</h2>
          <p>操作、状态、校验和预检提示</p>
        </div>
        <span className={warningCount ? "log-count warning" : "log-count"}>
          {warningCount || visibleEntries.length}
        </span>
      </div>

      <div className="log-list">
        {visibleEntries.length ? (
          visibleEntries.map((entry) => (
            <div className={`log-item ${entry.level || "info"}`} key={entry.id}>
              <strong>{entry.meta || entry.action || "status"}</strong>
              <span>{formatActivityLogMessage(entry) || entry.message}</span>
              <code>{entry.source || formatTime(entry.createdAt, lastUpdatedAt)}</code>
            </div>
          ))
        ) : (
          <p className="muted">暂无操作、状态、校验或预检日志</p>
        )}
      </div>
    </section>
  );
}
