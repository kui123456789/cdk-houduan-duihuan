import { Layers, X } from "lucide-react";
import { AccessibleDialog } from "../common/AccessibleDialog.jsx";

export function CdkPoolPickerDialog({
  open,
  title = "选择卡密池",
  message = "多个卡密池都有卡密，请选择本次从哪个池开始兑换。",
  choices = [],
  onSelect,
  onClose
}) {
  const normalizedChoices = Array.isArray(choices) ? choices : [];
  const canClose = typeof onClose === "function";
  const canSelect = typeof onSelect === "function";

  return (
    <AccessibleDialog
      open={open}
      onClose={onClose}
      titleId="cdk-pool-picker-title"
      className="cdk-pool-picker-dialog"
      backdropClassName="cdk-pool-picker-backdrop"
      initialFocusSelector=".cdk-pool-picker-choice:not([disabled])"
    >
        <div className="cdk-pool-picker-header">
          <div>
            <h2 id="cdk-pool-picker-title">{title}</h2>
            <p>{message}</p>
          </div>
          {canClose ? (
            <button
              type="button"
              className="cdk-pool-picker-close"
              onClick={onClose}
              aria-label="关闭"
            >
              <X size={16} />
            </button>
          ) : null}
        </div>

        <div className="cdk-pool-picker-choices">
          {normalizedChoices.map((choice) => (
            <button
              type="button"
              className="cdk-pool-picker-choice"
              key={choice.id}
              onClick={() => onSelect(choice.id)}
              disabled={!canSelect}
            >
              <Layers size={16} />
              <span>{choice.label}</span>
              <strong>{choice.count}</strong>
            </button>
          ))}
        </div>
    </AccessibleDialog>
  );
}
