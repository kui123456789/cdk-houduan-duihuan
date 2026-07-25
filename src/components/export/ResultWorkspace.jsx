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
  canCopyPixSuccess,
  accountStatusText,
  cdkUsageStats,
  backendRedeemText,
  exportGenerationState,
  onCopySuccess,
  onDownloadSuccess,
  onRequestExportCleanup
}) {
  return (
    <section className="result-workspace" aria-label="结果导出">
      <div className="result-export-row">
        <SuccessExportCard
          title="UPI 成功导出"
          subtitle="仅 success + Plus；UPI 和 UPI VIP 都进入此池"
          value={successExports.upi}
          downloadFileName="upi_success_accounts.txt"
          disabled={!canCopyUpiSuccess}
          exportGenerated={exportGenerationState.upi?.status === "export_generated"}
          onCopy={() => onCopySuccess("upi")}
          onDownload={() => onDownloadSuccess("upi")}
          onCleanup={() => onRequestExportCleanup("upi")}
        />

        <SuccessExportCard
          title="IDEAL 成功导出"
          subtitle="仅 success + Plus；IDEAL 和 IDEAL VIP 都进入此池"
          value={successExports.ideal}
          downloadFileName="ideal_success_accounts.txt"
          disabled={!canCopyIdealSuccess}
          exportGenerated={exportGenerationState.ideal?.status === "export_generated"}
          onCopy={() => onCopySuccess("ideal")}
          onDownload={() => onDownloadSuccess("ideal")}
          onCleanup={() => onRequestExportCleanup("ideal")}
        />

        <SuccessExportCard
          title="PIX 成功导出"
          subtitle="仅 success + Plus；PIX 和 PIX VIP 都进入此池"
          value={successExports.pix}
          downloadFileName="pix_success_accounts.txt"
          disabled={!canCopyPixSuccess}
          exportGenerated={exportGenerationState.pix?.status === "export_generated"}
          onCopy={() => onCopySuccess("pix")}
          onDownload={() => onDownloadSuccess("pix")}
          onCleanup={() => onRequestExportCleanup("pix")}
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
