import { UploadButton } from "../common/UploadButton";

export function CdkPoolCard({ pool, value, onChange, onPaste, onUpload }) {
  return (
    <section className={`pool-card ${pool.id}`}>
      <div className="pool-card-header">
        <div>
          <span className="pool-kicker">{pool.shortLabel}</span>
          <h3>{pool.label}</h3>
          <p>{pool.description}</p>
        </div>
      </div>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onPaste={onPaste}
        placeholder={pool.placeholder}
        spellCheck="false"
        wrap="off"
      />
      <UploadButton label={`上传 ${pool.shortLabel} .txt`} onChange={onUpload} />
    </section>
  );
}
