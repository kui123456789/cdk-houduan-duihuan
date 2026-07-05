import {
  appendImportedText,
  inspectAccountText,
  normalizeAccountText
} from "../redeemLogic.js";

export function shouldAppendAccountImport(text) {
  return String(text || "").trim().length > 0;
}

export function createAccountInputNotice({ added, duplicate, invalid }) {
  const parts = [`已添加 ${added} 个账号`];
  if (duplicate) parts.push(`跳过重复 ${duplicate} 个`);
  if (invalid) parts.push(`格式错误 ${invalid} 行`);
  return parts.join("，");
}

export function mergeAccountInputErrors(existingErrors, accountErrors) {
  const preserved = (existingErrors || []).filter(
    (error) => !["account_format", "account_duplicate"].includes(error?.type)
  );
  return [...preserved, ...(accountErrors || [])];
}

async function readTextFile(file) {
  return await file.text();
}

function downloadTextFile(fileName, content) {
  const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function useAccountInput({
  accountText,
  accountTextRef,
  setAccountText,
  setAccountNotice,
  setErrors,
  showToast = () => {},
  setStatusMessage = () => {},
  resetPreflightSummary = () => {},
  requestAccountInputRemovalConfirmation = () => false,
  readAccountTextFile = readTextFile,
  downloadAccountTextFile = downloadTextFile
}) {
  function setAccountInputErrors(accountErrors) {
    setErrors((prev) => mergeAccountInputErrors(prev, accountErrors));
  }

  function applyAccountTextEdit(inspected) {
    setAccountText(inspected.text);
    resetPreflightSummary();
    setAccountInputErrors(inspected.errors);
    if (inspected.errors.length) {
      setAccountNotice(`发现 ${inspected.errors.length} 个账号问题，格式问题不会进入`);
    } else {
      setAccountNotice("");
    }
    if (inspected.duplicateCount) {
      setStatusMessage(`已自动去重 ${inspected.duplicateCount} 个重复账号`);
    }
  }

  function handleAccountTextChange(value) {
    const inspected = inspectAccountText(value);
    if (requestAccountInputRemovalConfirmation(inspected, "edit")) return;
    applyAccountTextEdit(inspected);
  }

  function applyAccountTextPaste(normalized) {
    setAccountText(normalized.text);
    resetPreflightSummary();
    setAccountInputErrors(normalized.errors);
    setAccountNotice(
      normalized.invalidCount || normalized.duplicateCount
        ? `粘贴账号已处理：保留 ${normalized.accountCount} 个有效账号` +
            (normalized.duplicateCount ? `，自动去重 ${normalized.duplicateCount} 行` : "") +
            (normalized.invalidCount ? `，拒绝格式错误 ${normalized.invalidCount} 行` : "")
        : ""
    );
    setStatusMessage(
      `已粘贴账号，保留 ${normalized.accountCount} 个有效账号` +
        (normalized.duplicateCount ? `，自动去重 ${normalized.duplicateCount} 行` : "") +
        (normalized.invalidCount ? `，拒绝格式错误 ${normalized.invalidCount} 行` : "")
    );
  }

  function handleAccountTextPaste(event) {
    const pastedText = event.clipboardData?.getData("text");
    if (!pastedText) return;

    event.preventDefault();
    const target = event.currentTarget;
    const start = target.selectionStart ?? accountText.length;
    const end = target.selectionEnd ?? start;
    const nextText = `${accountText.slice(0, start)}${pastedText}${accountText.slice(end)}`;
    const normalized = normalizeAccountText(nextText);
    if (requestAccountInputRemovalConfirmation(normalized, "paste")) return;

    applyAccountTextPaste(normalized);
  }

  function applyAccountTextCleanup(normalized) {
    setAccountText(normalized.text);
    resetPreflightSummary();
    setAccountInputErrors(normalized.errors);
    setAccountNotice(
      normalized.invalidCount || normalized.duplicateCount
        ? `已清理账号输入：保留 ${normalized.accountCount} 个有效账号` +
            (normalized.duplicateCount ? `，自动去重 ${normalized.duplicateCount} 行` : "") +
            (normalized.invalidCount ? `，拒绝格式错误 ${normalized.invalidCount} 行` : "")
        : ""
    );
    setStatusMessage(
      `已清理账号输入，保留 ${normalized.accountCount} 个有效账号` +
        (normalized.duplicateCount ? `，自动去重 ${normalized.duplicateCount} 行` : "") +
        (normalized.invalidCount ? `，拒绝格式错误 ${normalized.invalidCount} 行` : "")
    );
  }

  function cleanupAccountText() {
    const normalized = normalizeAccountText(accountText);
    if (normalized.text !== accountText) {
      if (requestAccountInputRemovalConfirmation(normalized, "cleanup")) return;
      applyAccountTextCleanup(normalized);
    }
  }

  async function handleAccountFileUpload(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    const text = await readAccountTextFile(file);
    const latestAccountText = accountTextRef?.current ?? accountText;
    const beforeCount = normalizeAccountText(latestAccountText).accountCount;
    const importedText = shouldAppendAccountImport(text)
      ? appendImportedText(latestAccountText, text)
      : latestAccountText;
    const normalized = normalizeAccountText(importedText);
    const addedCount = Math.max(normalized.accountCount - beforeCount, 0);

    setAccountText(normalized.text);
    resetPreflightSummary();
    setAccountInputErrors(normalized.errors);
    setAccountNotice(
      normalized.invalidCount || normalized.duplicateCount
        ? `上传账号已处理：新增 ${addedCount} 行` +
            (normalized.duplicateCount ? `，自动去重 ${normalized.duplicateCount} 行` : "") +
            (normalized.invalidCount ? `，拒绝格式错误 ${normalized.invalidCount} 行` : "")
        : ""
    );
    setStatusMessage(
      `已追加账号文件：${file.name}，新增 ${addedCount} 行` +
        (normalized.duplicateCount ? `，自动去重 ${normalized.duplicateCount} 行` : "") +
        (normalized.invalidCount ? `，拒绝格式错误 ${normalized.invalidCount} 行` : "")
    );
  }

  function exportAccountInput() {
    const normalized = normalizeAccountText(accountText);
    if (!normalized.text) {
      const message = "没有可导出的账号";
      setStatusMessage(message);
      showToast(message, "error");
      return;
    }

    if (normalized.text !== accountText) {
      setAccountText(normalized.text);
      setAccountInputErrors(normalized.errors);
    }

    downloadAccountTextFile("accounts_input.txt", normalized.text);
    const message = `账号已导出：${normalized.accountCount} 行`;
    setStatusMessage(message);
    showToast(message);
  }

  return {
    handleAccountTextChange,
    handleAccountTextPaste,
    cleanupAccountText,
    handleAccountFileUpload,
    exportAccountInput,
    applyAccountTextEdit,
    applyAccountTextPaste,
    applyAccountTextCleanup
  };
}
