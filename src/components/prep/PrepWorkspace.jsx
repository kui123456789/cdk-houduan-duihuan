import { ClipboardCopy, Download, Eye, EyeOff, FileSearch, Shield, Trash2, Upload } from "lucide-react";
import { SAMPLE_ACCOUNT } from "../../config/redeemConstants";
import { PanelHeader } from "../common/PanelHeader";
import { CdkPoolCard } from "../forms/CdkPoolCard";
import { InputPanel } from "../forms/InputPanel";
import { UploadButton } from "../common/UploadButton";

export function PrepWorkspace({ api, account, summary, cdk }) {
  return (
    <section className="prep-grid">
      <ApiKeyCard api={api} />
      <AccountInputCard account={account} />
      <PrepSummaryCard summary={summary} />
      <CdkPoolBoard cdk={cdk} />
    </section>
  );
}

function ApiKeyCard({ api }) {
  return (
    <section className="api-card" aria-label="API Key 配置">
      <PanelHeader
        icon={<Shield size={17} />}
        title="外部 API Key"
        subtitle="仅保存在本地浏览器，用于本机代理转发"
      />
      <label className="field-stack">
        <span>API Key</span>
        <div className="secret-input">
          <input
            type={api.show ? "text" : "password"}
            value={api.value}
            onChange={(event) => api.onChange(event.target.value)}
            placeholder="ext_redeem_..."
            spellCheck="false"
          />
          <button
            type="button"
            className="icon-button"
            aria-label={api.show ? "隐藏 API Key" : "显示 API Key"}
            onClick={api.onToggleVisible}
          >
            {api.show ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>
      </label>
      <button type="button" className="wide-ghost-button" onClick={api.onClear}>
        <Trash2 size={16} />
        清除本地保存
      </button>
    </section>
  );
}

function AccountInputCard({ account }) {
  return (
    <InputPanel
      title="账号输入"
      subtitle="格式：邮箱---密码---2fa---at---时间戳"
      count={`账号 ${account.total} 行 / 可用 ${account.available}`}
      icon={<Upload size={17} />}
      actions={
        <>
          <button
            type="button"
            className="ghost-button"
            onClick={account.onExport}
            disabled={!account.total}
            title={account.total ? `导出剩余 ${account.total} 行账号` : "没有可导出的账号"}
          >
            <Download size={15} />
            导出账号
          </button>
          <UploadButton label="上传账号 .txt" onChange={account.onUpload} />
        </>
      }
    >
      <textarea
        value={account.value}
        onChange={(event) => account.onChange(event.target.value)}
        onPaste={account.onPaste}
        onBlur={account.onBlur}
        placeholder={SAMPLE_ACCOUNT}
        spellCheck="false"
        wrap="off"
      />
      <div className={account.issueCount || account.notice ? "input-validity warning" : "input-validity"}>
        {account.notice
          ? account.notice
          : account.issueCount
            ? `发现 ${account.issueCount} 个账号问题，格式问题不会进入`
            : account.statusText}
      </div>
    </InputPanel>
  );
}

function PrepSummaryCard({ summary }) {
  const note = getPrepSummaryNote(summary);
  const noteClassName = summary.isPolling
    ? "prep-summary-note active"
    : summary.cooldownAccountCount ||
        summary.attemptLimitedAccountCount ||
        summary.activeTaskAccountCount ||
        summary.displayedWaitingAccounts ||
        summary.displayedWaitingCdkeys ||
        (summary.hasPreflightSummary && summary.preflightAttentionCount)
      ? "prep-summary-note warning"
      : "prep-summary-note";

  return (
    <section className="prep-summary" aria-label="准备状态">
      <PanelHeader
        icon={<FileSearch size={17} />}
        title="准备状态"
        subtitle={summary.apiKeyFilled ? "API Key 已填写" : "等待 API Key"}
      />
      <div className="prep-summary-grid">
        <PrepSummaryItem label="账号池" value={summary.accountLineCount} />
        <PrepSummaryItem label="可用账号" value={summary.activeAccountLineCount} />
        <PrepSummaryItem label="封存中" value={summary.cooldownAccountCount} />
        <PrepSummaryItem label="已达 3/3" value={summary.attemptLimitedAccountCount} />
        <PrepSummaryItem label="任务占用" value={summary.activeTaskAccountCount} />
        <PrepSummaryItem label="原导入估算" value={summary.estimatedImportedAccountCount} />
        <PrepSummaryItem label="已处理 Plus" value={summary.processedPlusAccountCount} />
        <PrepSummaryItem label="CDK 总数" value={summary.availableCdkCount} />
        <PrepSummaryItem label="可用 CDK" value={summary.displayedAvailableCdkCount} />
        <PrepSummaryItem label="已使用 CDK" value={summary.hasPreflightSummary ? summary.preflightSummary.used : 0} />
        <PrepSummaryItem label="占用中 CDK" value={summary.hasPreflightSummary ? summary.preflightSummary.busy : 0} />
        <PrepSummaryItem label="本次提交" value={summary.displayedRedeemablePairCount} />
        <PrepSummaryItem label="等待卡密" value={summary.displayedWaitingAccounts} />
        <PrepSummaryItem label="等待账号" value={summary.displayedWaitingCdkeys} />
      </div>
      <div className={noteClassName}>{note}</div>
    </section>
  );
}

function PrepSummaryItem({ label, value }) {
  return (
    <div className="prep-summary-item">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function getPrepSummaryNote(summary) {
  if (summary.isPolling) return "自动轮询中";
  if (summary.hasPreflightSummary) {
    const base =
      `最近预检：可用 ${summary.preflightSummary.available} 张，已使用 ${summary.preflightSummary.used} 张，` +
      `占用中 ${summary.preflightSummary.busy} 张，查询失败 ${summary.preflightSummary.unknown} 张；` +
      `本次提交 ${summary.preflightSummary.submitted} 个账号`;
    if (summary.displayedWaitingAccounts) {
      return `${base}；${summary.displayedWaitingAccounts} 个账号等待补充卡密`;
    }
    if (summary.displayedWaitingCdkeys) {
      return `${base}；${summary.displayedWaitingCdkeys} 张 CDK 等待后续账号`;
    }
    return base;
  }
  if (summary.cooldownAccountCount) {
    return `${summary.cooldownAccountCount} 个账号封存中，24 小时后自动恢复兑换队列`;
  }
  if (summary.attemptLimitedAccountCount) {
    return `${summary.attemptLimitedAccountCount} 个账号已达 ${summary.accountAttemptLimit}/${summary.accountAttemptLimit} 次，本地不会继续提交`;
  }
  if (summary.activeTaskAccountCount) {
    return `${summary.activeTaskAccountCount} 个账号已有兑换任务，避免重复提交`;
  }
  if (summary.displayedWaitingAccounts) {
    return `当前还有 ${summary.displayedAvailableCdkCount} 个待预检 CDK，最多提交 ${summary.displayedRedeemablePairCount} 个账号；剩余 ${summary.displayedWaitingAccounts} 个账号等待补充卡密`;
  }
  if (summary.displayedWaitingCdkeys) {
    return `当前有 ${summary.displayedWaitingCdkeys} 个待预检 CDK 暂无账号配对`;
  }
  return summary.rowsLength ? "已有请求记录" : "等待开始兑换或查询";
}

function CdkPoolBoard({ cdk }) {
  return (
    <section className="cdk-pool-board">
      <div className="section-heading">
        <PanelHeader
          icon={<ClipboardCopy size={17} />}
          title="三渠道卡密池"
          subtitle="VIP、IDEAL、UPI 分池录入；提交时按池子顺序配对账号"
        />
        <div className="panel-actions">
          <button type="button" className="ghost-button" onClick={cdk.onOpenImport}>
            <Upload size={15} />
            导入卡密
          </button>
        </div>
      </div>
      <div className="pool-grid">
        {cdk.poolDefinitions.map((pool) => (
          <CdkPoolCard
            key={pool.id}
            pool={pool}
            value={cdk.pools[pool.id] || ""}
            onChange={(value) => cdk.onChange(pool.id, value)}
            onPaste={(event) => cdk.onPaste(event, pool.id)}
            onUpload={(event) => cdk.onUpload(event, pool.id)}
          />
        ))}
      </div>
      <div className="input-validity">
        {cdk.validCount
          ? `已检测到 ${cdk.validCount} 条 CDK，可用 ${cdk.availableCount} 条`
          : "等待 VIP / IDEAL / UPI 卡密输入"}
      </div>
    </section>
  );
}
