import {
  AccountStatusCard,
  BackendRedeemCard,
  CdkUsageCard,
  SuccessExportCard
} from "./ResultExportCard";

export function ResultWorkspace({
  successExports,
  canCopyUpiSuccess,
  canCopyIdealSuccess,
  accountStatusText,
  cdkUsageStats,
  backendRedeemText,
  onCopySuccess,
  onDownloadSuccess
}) {
  return (
    <section className="result-workspace" aria-label="结果导出">
      <div className="result-export-row">
        <SuccessExportCard
          title="UPI 成功导出"
          subtitle="仅 success + Plus + UPI 卡密池"
          value={successExports.upi}
          downloadFileName="upi_success_accounts.txt"
          disabled={!canCopyUpiSuccess}
          onCopy={() => onCopySuccess("upi")}
          onDownload={() => onDownloadSuccess("upi")}
        />

        <SuccessExportCard
          title="IDEAL 成功导出"
          subtitle="仅 success + Plus；IDEAL 和 VIP 都进入此池"
          value={successExports.ideal}
          downloadFileName="ideal_success_accounts.txt"
          disabled={!canCopyIdealSuccess}
          onCopy={() => onCopySuccess("ideal")}
          onDownload={() => onDownloadSuccess("ideal")}
        />
      </div>

      <div className="result-detail-grid">
        <AccountStatusCard value={accountStatusText} />
        <CdkUsageCard stats={cdkUsageStats} />
        <BackendRedeemCard value={backendRedeemText} />
      </div>
    </section>
  );
}
