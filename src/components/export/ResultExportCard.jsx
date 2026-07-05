import { useEffect, useState } from "react";
import { ClipboardCopy, Download } from "lucide-react";

export function SuccessExportCard({
  title,
  subtitle,
  value,
  downloadFileName,
  disabled,
  onCopy,
  onDownload,
  placeholder = "邮箱---密码---2fa---时间戳"
}) {
  const [downloadUrl, setDownloadUrl] = useState("");

  useEffect(() => {
    if (!value) {
      setDownloadUrl("");
      return undefined;
    }

    const url = URL.createObjectURL(new Blob([value], { type: "text/plain;charset=utf-8" }));
    setDownloadUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [value]);

  return (
    <div className="output-card">
      <div className="section-heading compact">
        <div>
          <h2>{title}</h2>
          <p>{subtitle}</p>
        </div>
        <div className="inline-actions">
          <button className="ghost-button" onClick={onCopy} disabled={disabled}>
            <ClipboardCopy size={16} />
            复制结果
          </button>
          <a
            className={`primary-button small download-link ${disabled ? "disabled" : ""}`}
            href={disabled ? undefined : downloadUrl}
            download={downloadFileName}
            aria-disabled={disabled}
            tabIndex={disabled ? -1 : 0}
            onClick={(event) => {
              if (disabled || !downloadUrl) {
                event.preventDefault();
                return;
              }
              window.setTimeout(onDownload, 0);
            }}
          >
            <Download size={16} />
            下载结果
          </a>
        </div>
      </div>
      <textarea value={value} readOnly placeholder={placeholder} wrap="off" />
    </div>
  );
}

export function AccountStatusCard({ value }) {
  return (
    <div className="output-card account-status-card">
      <div className="section-heading compact">
        <div>
          <h2>账号兑换状态</h2>
          <p>邮箱、CDK、尝试、接口状态、Plus 判断和原因</p>
        </div>
      </div>
      <textarea
        value={value}
        readOnly
        placeholder="查询状态后显示：邮箱---CDK---尝试---状态---中文状态---Plus判断---原因"
        wrap="off"
      />
    </div>
  );
}

export function CdkUsageCard({ stats }) {
  return (
    <div className="output-card cdk-usage-card">
      <div className="section-heading compact">
        <div>
          <h2>卡密使用明细</h2>
          <p>
            总数 {stats.total} · 已使用 {stats.usedCount} · 未使用 {stats.unusedCount}
            {stats.duplicateSuccessEmailCount
              ? ` · 发现 ${stats.duplicateSuccessEmailCount} 个邮箱多卡密成功`
              : ""}
          </p>
        </div>
      </div>
      <div className="usage-stat-grid">
        <div className="usage-stat">
          <span>已使用</span>
          <strong>{stats.usedCount}</strong>
        </div>
        <div className="usage-stat">
          <span>未使用</span>
          <strong>{stats.unusedCount}</strong>
        </div>
      </div>
      <div className="usage-list-grid">
        <label>
          <span>已使用卡密</span>
          <textarea value={stats.usedText} readOnly placeholder="查询状态后显示已使用卡密" wrap="off" />
        </label>
        <label>
          <span>未使用卡密</span>
          <textarea value={stats.unusedText} readOnly placeholder="查询状态后显示未使用卡密" wrap="off" />
        </label>
      </div>
    </div>
  );
}

export function BackendRedeemCard({ value }) {
  return (
    <div className="output-card backend-card">
      <div className="section-heading compact">
        <div>
          <h2>后台兑换情况</h2>
          <p>后台状态、原因、可取消、可重试、token 标记</p>
        </div>
      </div>
      <textarea value={value} readOnly placeholder="查询状态后显示后台兑换情况" wrap="off" />
    </div>
  );
}
