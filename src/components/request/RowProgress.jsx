function clampPercent(value) {
  return Math.min(Math.max(Number(value || 0), 0), 100);
}

const PROGRESS_STEPS = [50, 70, 85];

export function RowProgress({ row, getProgress, queueInfo }) {
  const progress = getProgress(row);
  const safePercent = clampPercent(progress.percent);
  const note = queueInfo && safePercent === 50 ? String(queueInfo.note || "").trim() : "";
  return (
    <div className={`row-progress ${progress.tone}`} title={`${progress.label} ${safePercent}%`}>
      <div className="row-progress-meta">
        <span>{progress.label}</span>
        <strong>{safePercent}%</strong>
      </div>
      <div className="row-progress-track" aria-hidden="true">
        <span style={{ width: `${safePercent}%` }} />
        {PROGRESS_STEPS.map((step) => (
          <i
            key={step}
            className={`row-progress-step ${safePercent >= step ? "complete" : ""}`}
            style={{ left: `${step}%` }}
          />
        ))}
      </div>
      {note ? <div className="row-progress-note">{note}</div> : null}
    </div>
  );
}
