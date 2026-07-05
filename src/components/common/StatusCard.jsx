export function StatusCard({ label, value, tone = "", title = "" }) {
  const textValue = /[^\d./-]/.test(String(value ?? ""));
  return (
    <div className={`status-card ${tone} ${textValue ? "text-value" : ""}`} title={title}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
