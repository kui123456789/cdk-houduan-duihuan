import {
  BadgeCheck,
  Download,
  FileSearch,
  MailCheck,
  RefreshCw,
  ShieldAlert,
  Trash2,
  Upload
} from "lucide-react";
import {
  ACCOUNT_AUDIT_FILTERS,
  getAccountAuditStatus,
  getAccountAuditStatusMeta
} from "../../domain/accountAudit.js";

function formatCheckedAt(row) {
  const values = [row?.emailVerificationCheckedAt, row?.subscriptionCheckedAt].filter(Boolean);
  if (!values.length) return "-";
  const date = new Date(values.sort().at(-1));
  return Number.isNaN(date.getTime()) ? values.at(-1) : date.toLocaleString("zh-CN", { hour12: false });
}

function getSubscriptionText(row) {
  if (row?.subscriptionStatus === "checking") return "检查中";
  if (row?.subscriptionCategory === "plus" || row?.subscriptionStatus === "plus") return row.subscriptionTitle || "Plus";
  if (row?.subscriptionCategory === "not_plus" || row?.subscriptionStatus === "not_plus") return row.subscriptionTitle || "非 Plus";
  if (row?.subscriptionCategory === "token_invalid") return "Token 失效";
  if (row?.subscriptionCategory === "no_account") return "账号不存在";
  if (row?.subscriptionStatus === "error") return row.subscriptionTitle || "检查失败";
  return row?.accessToken ? "待检查" : "缺少 at";
}

function getEmailText(row) {
  if (row?.emailVerificationStatus === "checking") return "检查中";
  if (row?.emailVerificationStatus === "banned") return "账号已封禁";
  if (row?.emailVerificationStatus === "verified") return "Plus 开通邮件";
  if (row?.emailVerificationStatus === "not_found") return "未发现相关邮件";
  if (row?.emailVerificationStatus === "missing_url") return "缺少邮箱取件链接";
  if (row?.emailVerificationStatus === "error") return row.emailVerificationTitle || "检查失败";
  return row?.pickupUrl ? "待检查" : "缺少邮箱取件链接";
}

export function AccountAuditWorkspace({ audit }) {
  const {
    inputText,
    setInputText,
    parsed,
    rows,
    visibleRows,
    counts,
    filter,
    setFilter,
    busy,
    notice,
    importAccounts,
    checkSubscriptions,
    checkEmails,
    download,
    clear
  } = audit;

  async function handleFileUpload(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    importAccounts(await file.text());
  }

  return (
    <section className="account-audit-workspace" aria-label="账号检测">
      <div className="audit-import-panel">
        <div className="panel-header">
          <div>
            <h2>账号检测</h2>
            <p>导入完整账号行后分别检查订阅和邮箱通知。</p>
          </div>
          <div className="panel-actions">
            <label className="ghost-button audit-file-button" title="导入账号文件">
              <Upload size={15} />
              <span>导入文件</span>
              <input type="file" accept=".txt,text/plain" onChange={handleFileUpload} />
            </label>
            <button type="button" className="secondary-button" onClick={() => importAccounts()} disabled={!inputText.trim()}>
              <FileSearch size={15} />
              载入账号
            </button>
            <button type="button" className="ghost-button" onClick={clear} disabled={!inputText && !rows.length} title="清空账号检测">
              <Trash2 size={15} />
              清空
            </button>
          </div>
        </div>
        <textarea
          className="audit-input"
          value={inputText}
          onChange={(event) => setInputText(event.target.value)}
          placeholder="邮箱---取件地址---at---时间戳\n每行一个账号"
          spellCheck="false"
          wrap="off"
          aria-label="原始账号输入"
        />
        <div className="audit-import-footer">
          <span>{parsed.accountCount} 个有效账号 · {parsed.invalidCount} 个格式错误 · {parsed.duplicateCount} 个重复</span>
          <span>{notice || ""}</span>
        </div>
        {parsed.errors.length ? (
          <div className="audit-errors" role="status">
            {parsed.errors.slice(0, 5).map((error, index) => (
              <div key={`${error.lineNumber}-${index}`}>第 {error.lineNumber} 行：{error.reason}</div>
            ))}
            {parsed.errors.length > 5 ? <div>还有 {parsed.errors.length - 5} 条输入问题</div> : null}
          </div>
        ) : null}
      </div>

      <div className="audit-stat-grid" aria-label="账号检测统计">
        {[
          ["plus_verified", "Plus 已验证"],
          ["plus_pending_email", "Plus 待邮箱"],
          ["banned", "已封禁"],
          ["not_plus", "非 Plus"],
          ["token_invalid", "Token 失效"],
          ["no_account", "账号不存在"],
          ["check_failed", "检查失败"],
          ["pending", "待检查"]
        ].map(([id, label]) => (
          <button key={id} type="button" className={`audit-stat ${filter === id ? "active" : ""}`} onClick={() => setFilter(id)}>
            <span>{label}</span>
            <strong>{counts[id] || 0}</strong>
          </button>
        ))}
      </div>

      <div className="audit-control-row">
        <div className="audit-filter-tabs" role="tablist" aria-label="账号状态筛选">
          {ACCOUNT_AUDIT_FILTERS.map((item) => (
            <button key={item.id} type="button" role="tab" aria-selected={filter === item.id} className={filter === item.id ? "active" : ""} onClick={() => setFilter(item.id)}>
              {item.label}
              <span>{item.id === "all" ? rows.length : counts[item.id] || 0}</span>
            </button>
          ))}
        </div>
        <div className="audit-actions">
          <button type="button" className="secondary-button" onClick={() => checkSubscriptions()} disabled={Boolean(busy) || !visibleRows.length}>
            <BadgeCheck size={15} />
            {busy === "subscription" ? "检查订阅中" : "检查订阅状态"}
          </button>
          <button type="button" className="secondary-button" onClick={() => checkEmails()} disabled={Boolean(busy) || !visibleRows.length}>
            <MailCheck size={15} />
            {busy === "email" ? "检查邮箱中" : "检查邮箱通知"}
          </button>
          <button type="button" className="ghost-button" onClick={() => download(filter)} disabled={!visibleRows.length} title="导出当前筛选的原始账号">
            <Download size={15} />
            导出当前分类
          </button>
        </div>
      </div>

      <div className="audit-table-panel">
        <div className="audit-table-scroll">
          <table className="audit-table">
            <thead>
              <tr>
                <th>邮箱</th>
                <th>最终状态</th>
                <th>订阅</th>
                <th>邮箱通知</th>
                <th>检查时间</th>
                <th>原因</th>
                <th aria-label="操作" />
              </tr>
            </thead>
            <tbody>
              {visibleRows.length ? visibleRows.map((row) => {
                const meta = getAccountAuditStatusMeta(row);
                return (
                  <tr key={row.id}>
                    <td>
                      <strong className="audit-email">{row.email || "-"}</strong>
                      <small>第 {row.lineNumber} 行</small>
                    </td>
                    <td><span className={`audit-status ${meta.tone}`}><span className="audit-status-dot" />{meta.label}</span></td>
                    <td>{getSubscriptionText(row)}</td>
                    <td>{getEmailText(row)}</td>
                    <td>{formatCheckedAt(row)}</td>
                    <td className="audit-reason">{row.emailVerificationReason || row.subscriptionReason || "-"}</td>
                    <td>
                      <div className="audit-row-actions">
                        <button type="button" className="icon-button" title="重新检查订阅" aria-label={`重新检查 ${row.email} 的订阅`} onClick={() => checkSubscriptions([row.id])} disabled={Boolean(busy)}>
                          <RefreshCw size={15} />
                        </button>
                        <button type="button" className="icon-button" title="重新检查邮箱" aria-label={`重新检查 ${row.email} 的邮箱`} onClick={() => checkEmails([row.id])} disabled={Boolean(busy)}>
                          <MailCheck size={15} />
                        </button>
                        {getAccountAuditStatus(row) === "banned" ? <ShieldAlert size={16} className="audit-ban-icon" aria-label="已封禁" /> : null}
                      </div>
                    </td>
                  </tr>
                );
              }) : (
                <tr><td colSpan="7" className="audit-empty">暂无账号检测结果</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
