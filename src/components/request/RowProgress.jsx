function clampPercent(value) {
  return Math.min(Math.max(Number(value || 0), 0), 100);
}

export function RowProgress({ row, getProgress }) {
  const progress = getProgress(row);
  const safePercent = clampPercent(progress.percent);
  return (
    <div className={`row-progress ${progress.tone}`} title={`${progress.label} ${safePercent}%`}>
      <div className="row-progress-meta">
        <span>{progress.label}</span>
        <strong>{safePercent}%</strong>
      </div>
      <div className="row-progress-track" aria-hidden="true">
        <span style={{ width: `${safePercent}%` }} />
      </div>
    </div>
  );
}
