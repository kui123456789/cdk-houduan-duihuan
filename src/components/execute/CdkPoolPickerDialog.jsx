import { useEffect, useRef } from "react";
import { Layers, X } from "lucide-react";

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

export function CdkPoolPickerDialog({
  open,
  title = "选择卡密池",
  message = "多个卡密池都有卡密，请选择本次从哪个池开始兑换。",
  choices = [],
  onSelect,
  onClose
}) {
  const dialogRef = useRef(null);
  const previousFocusRef = useRef(null);
  const onCloseRef = useRef(onClose);
  const normalizedChoices = Array.isArray(choices) ? choices : [];
  const canClose = typeof onClose === "function";
  const canSelect = typeof onSelect === "function";

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return undefined;

    previousFocusRef.current = document.activeElement;

    const getFocusableElements = () =>
      Array.from(dialogRef.current?.querySelectorAll(FOCUSABLE_SELECTOR) || []).filter(
        (element) => element.offsetParent !== null
      );

    const focusTimer = window.setTimeout(() => {
      const firstChoice = dialogRef.current?.querySelector(".cdk-pool-picker-choice:not([disabled])");
      const closeButton = dialogRef.current?.querySelector(".cdk-pool-picker-close");
      (firstChoice || closeButton || dialogRef.current)?.focus();
    }, 0);

    function handleKeyDown(event) {
      if (event.key === "Escape" && canClose) {
        event.preventDefault();
        onCloseRef.current?.();
        return;
      }

      if (event.key !== "Tab") return;

      const focusableElements = getFocusableElements();
      if (!focusableElements.length) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }

      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];

      if (event.shiftKey && document.activeElement === firstElement) {
        event.preventDefault();
        lastElement.focus();
      } else if (!event.shiftKey && document.activeElement === lastElement) {
        event.preventDefault();
        firstElement.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", handleKeyDown);
      if (previousFocusRef.current instanceof HTMLElement) {
        previousFocusRef.current.focus();
      }
      previousFocusRef.current = null;
    };
  }, [open, canClose]);

  if (!open) return null;

  return (
    <div className="cdk-pool-picker-backdrop">
      <div
        ref={dialogRef}
        className="cdk-pool-picker-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cdk-pool-picker-title"
        tabIndex={-1}
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
      </div>
    </div>
  );
}
