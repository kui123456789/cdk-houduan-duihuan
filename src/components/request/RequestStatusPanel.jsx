import {
  CheckSquare,
  FileSearch,
  ListChecks,
  ListX,
  RotateCcw,
  Shield,
  Shuffle,
  Trash2,
  XCircle
} from "lucide-react";
import { DetailPanel } from "./DetailPanel";
import { StatusRow } from "./StatusRow";

export function RequestStatusPanel({
  statusMessage,
  lastUpdatedAt,
  hiddenHistoryRowCount,
  visibleRequestRows,
  selectedRows,
  selectedRecheckPlusRows,
  plusAccountRows,
  activeDetailRow,
  errors,
  isBusy,
  helpers,
  actions
}) {
  const allSelected =
    visibleRequestRows.length > 0 && visibleRequestRows.every((row) => row.selected);

  return (
    <div className="request-panel">
      <div className="section-heading">
        <div>
          <h2>请求状态</h2>
          <p>
            {statusMessage}
            {lastUpdatedAt ? ` · 更新时间 ${lastUpdatedAt}` : ""}
            {hiddenHistoryRowCount ? ` · 已隐藏历史换号 ${hiddenHistoryRowCount} 条` : ""}
          </p>
        </div>
        <span className="selection-count">
          已选 {selectedRows.length} / {visibleRequestRows.length}
        </span>
      </div>

      <div className="selection-toolbar" aria-label="批量选择">
        <button type="button" onClick={() => actions.setAllSelected(true)} disabled={!visibleRequestRows.length}>
          <CheckSquare size={14} />
          全选
        </button>
        <button type="button" onClick={() => actions.setAllSelected(false)} disabled={!selectedRows.length}>
          <ListX size={14} />
          清空
        </button>
        <button type="button" onClick={actions.invertSelectedRows} disabled={!visibleRequestRows.length}>
          <Shuffle size={14} />
          反选
        </button>
        <button
          type="button"
          onClick={() => actions.selectRowsByFilter(helpers.canCancelRow, "可取消")}
          disabled={!visibleRequestRows.length}
        >
          <XCircle size={14} />
          可取消
        </button>
        <button
          type="button"
          onClick={() => actions.selectRowsByFilter(helpers.canRetryVisibleRow, "可重试")}
          disabled={!visibleRequestRows.length}
        >
          <RotateCcw size={14} />
          可重试
        </button>
        <button
          type="button"
          onClick={() => actions.selectRowsByFilter((row) => row.status === "success", "已使用")}
          disabled={!visibleRequestRows.length}
        >
          <ListChecks size={14} />
          已使用
        </button>
        <button
          type="button"
          onClick={() => actions.selectRowsByFilter(helpers.isPlusAccountRow, "Plus")}
          disabled={!visibleRequestRows.length}
        >
          <Shield size={14} />
          Plus
        </button>
        <button
          type="button"
          onClick={() => actions.recheckPlusRows(selectedRows)}
          disabled={isBusy || !selectedRecheckPlusRows.length}
          title={
            selectedRecheckPlusRows.length
              ? `重新检查 ${selectedRecheckPlusRows.length} 个账号的 Plus 状态`
              : "先选中兑换成功且有 at 的账号"
          }
        >
          <RotateCcw size={14} />
          重查Plus
        </button>
        <button
          type="button"
          onClick={() => {
            const selectedPlusRows = selectedRows.filter(helpers.isPlusAccountRow);
            actions.deletePlusAccounts(selectedPlusRows.length ? selectedPlusRows : plusAccountRows);
          }}
          disabled={isBusy || !plusAccountRows.length}
        >
          <Trash2 size={14} />
          删除Plus
        </button>
        <button
          type="button"
          className="danger-filter-button"
          onClick={() => actions.deleteRows(selectedRows)}
          disabled={isBusy || !selectedRows.length}
          title="删除当前选中的请求，并从输入账号和卡密池移除对应内容"
        >
          <Trash2 size={14} />
          删除选中
        </button>
        <button
          type="button"
          onClick={() => actions.selectRowsByFilter((row) => row.status === "unused", "未使用")}
          disabled={!visibleRequestRows.length}
        >
          <FileSearch size={14} />
          未使用
        </button>
      </div>

      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  aria-label="全选请求"
                  checked={allSelected}
                  onChange={(event) => actions.setAllSelected(event.target.checked)}
                  disabled={!visibleRequestRows.length}
                />
              </th>
              <th>序号</th>
              <th>邮箱</th>
              <th>进度</th>
              <th>CDK</th>
              <th>渠道</th>
              <th>尝试</th>
              <th>状态</th>
              <th>中文状态</th>
              <th>Plus 判断</th>
              <th>订阅原因</th>
              <th>失败原因</th>
              <th>可取消</th>
              <th>可重试</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {visibleRequestRows.length ? (
              visibleRequestRows.map((row) => (
                <StatusRow
                  key={row.id}
                  row={row}
                  onSelect={() => actions.toggleSelected(row.id)}
                  onViewDetail={() => actions.setActiveDetailRowId(row.id)}
                  onCancel={() => actions.cancelRows([row])}
                  onRetry={() => actions.retryOrResubmitRows([row])}
                  onRecheckPlus={() => actions.recheckPlusRows([row])}
                  onDelete={() => actions.deleteRows([row])}
                  active={activeDetailRow?.id === row.id}
                  busy={isBusy}
                  helpers={helpers}
                />
              ))
            ) : (
              <tr>
                <td colSpan="15" className="empty-cell">
                  {hiddenHistoryRowCount
                    ? "当前没有正在负责兑换的账号；历史换号记录已隐藏，可在结果导出页查看追踪文本。"
                    : errors.length
                      ? `当前没有提交任务；发现 ${errors.length} 条导入/预检问题，请看页面底部日志，或补充未使用 CDK 后再开始兑换。`
                      : "还没有请求记录。可先往任一卡密池粘贴 CDK 点击“查询状态”，或配对账号后点击“开始兑换”。"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <DetailPanel row={activeDetailRow} helpers={helpers} />
    </div>
  );
}
