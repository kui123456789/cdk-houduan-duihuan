import { useEffect, useRef } from "react";
import {
  DIALOG_FOCUSABLE_SELECTOR,
  getDialogFocusTarget
} from "./dialogFocus.js";

const pointerFocusOriginRef = { current: null };
if (typeof document !== "undefined") {
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (!(event.target instanceof HTMLElement)) return;
      pointerFocusOriginRef.current =
        event.target.closest(DIALOG_FOCUSABLE_SELECTOR) || event.target;
    },
    true
  );
}

function getFocusableElements(container) {
  return Array.from(container?.querySelectorAll(DIALOG_FOCUSABLE_SELECTOR) || []).filter(
    (element) => element.offsetParent !== null
  );
}

function restoreFocus(origin) {
  if (!(origin instanceof HTMLElement)) return;
  if (origin.isConnected) {
    origin.focus();
    return;
  }

  const id = origin.id;
  const name = origin.getAttribute("name");
  const ariaLabel = origin.getAttribute("aria-label");
  const text = origin.textContent?.trim();
  const candidates = Array.from(document.querySelectorAll(origin.tagName.toLowerCase()));
  const replacement =
    (id ? document.getElementById(id) : null) ||
    candidates.find((element) => name && element.getAttribute("name") === name) ||
    candidates.find((element) => ariaLabel && element.getAttribute("aria-label") === ariaLabel) ||
    candidates.find((element) => text && element.textContent?.trim() === text);
  replacement?.focus();
}

export function AccessibleDialog({
  open,
  onClose,
  titleId,
  descriptionId,
  className,
  backdropClassName = "confirm-backdrop",
  initialFocusSelector,
  closeOnBackdrop = true,
  children
}) {
  const dialogRef = useRef(null);
  const previousFocusRef = useRef(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return undefined;
    const activeElement = document.activeElement;
    if (
      activeElement instanceof HTMLElement &&
      activeElement !== document.body &&
      !dialogRef.current?.contains(activeElement)
    ) {
      previousFocusRef.current = activeElement;
    } else if (!previousFocusRef.current) {
      previousFocusRef.current = pointerFocusOriginRef.current;
    }
    const focusOrigin = previousFocusRef.current;

    const focusTimer = window.setTimeout(() => {
      const preferred = initialFocusSelector
        ? dialogRef.current?.querySelector(initialFocusSelector)
        : null;
      const first = getFocusableElements(dialogRef.current)[0];
      (preferred || first || dialogRef.current)?.focus();
    }, 0);

    function handleKeyDown(event) {
      if (event.key === "Escape" && typeof onCloseRef.current === "function") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const focusableElements = getFocusableElements(dialogRef.current);
      const target = getDialogFocusTarget(
        focusableElements,
        document.activeElement,
        event.shiftKey
      );
      if (target === undefined) return;
      event.preventDefault();
      (target || dialogRef.current)?.focus();
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", handleKeyDown);
      window.setTimeout(() => restoreFocus(focusOrigin), 0);
    };
  }, [initialFocusSelector, open]);

  if (!open) return null;

  function handleBackdropClick(event) {
    if (
      closeOnBackdrop &&
      event.target === event.currentTarget &&
      typeof onCloseRef.current === "function"
    ) {
      onCloseRef.current();
    }
  }

  return (
    <div className={backdropClassName} role="presentation" onClick={handleBackdropClick}>
      <div
        ref={dialogRef}
        className={className}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
      >
        {children}
      </div>
    </div>
  );
}
