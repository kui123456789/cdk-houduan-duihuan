export const DIALOG_FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

export function getDialogFocusTarget(elements, activeElement, shiftKey) {
  if (!elements.length) return null;
  const firstElement = elements[0];
  const lastElement = elements[elements.length - 1];
  if (shiftKey && activeElement === firstElement) return lastElement;
  if (!shiftKey && activeElement === lastElement) return firstElement;
  return undefined;
}
