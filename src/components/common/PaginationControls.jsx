import { ChevronLeft, ChevronRight } from "lucide-react";

export function PaginationControls({ pagination, onPageChange, label = "列表" }) {
  const { page, totalPages, totalItems, startIndex, endIndex } = pagination;
  if (totalItems <= pagination.pageSize) return null;

  return (
    <nav className="pagination-controls" aria-label={`${label}分页`}>
      <span className="pagination-range">
        {startIndex + 1}-{endIndex} / {totalItems}
      </span>
      <button
        type="button"
        className="icon-button"
        onClick={() => onPageChange(page - 1)}
        disabled={page <= 1}
        aria-label={`上一页${label}`}
        title="上一页"
      >
        <ChevronLeft size={16} />
      </button>
      <span className="pagination-page" aria-live="polite">
        第 {page} / {totalPages} 页
      </span>
      <button
        type="button"
        className="icon-button"
        onClick={() => onPageChange(page + 1)}
        disabled={page >= totalPages}
        aria-label={`下一页${label}`}
        title="下一页"
      >
        <ChevronRight size={16} />
      </button>
    </nav>
  );
}
