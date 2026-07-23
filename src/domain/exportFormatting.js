import { DELIMITER } from "./accountParsing.js";

function replaceOrAppendTimestamp(exportLine, row, redemptionTimestamp) {
  const parts = exportLine.split(DELIMITER).map((part) => part.trim());
  const importedTimestamp = String(row?.timestamp || "").trim();
  const inputFormat = String(row?.inputFormat || "").trim();
  const lastIndex = parts.length - 1;
  const lastPart = parts[lastIndex] || "";
  const importedFormatHasTimestamp =
    inputFormat === "legacy_5" ||
    inputFormat === "chatgpt_session_json" ||
    inputFormat.endsWith("_timestamp");
  const hasImportedTimestamp =
    Boolean(importedTimestamp) &&
    (lastPart === importedTimestamp || importedFormatHasTimestamp);

  if (hasImportedTimestamp) {
    parts[lastIndex] = redemptionTimestamp;
  } else {
    parts.push(redemptionTimestamp);
  }

  return parts.join(DELIMITER);
}

export function getSuccessExportsByPool(rows) {
  return rows.reduce(
    (acc, row) => {
      const exportLine = getPlusExportLine(row);
      if (row.status !== "success" || row.isPlus !== true || !exportLine) return acc;
      const channel = String(row.channel || "").trim().toLowerCase();
      if (channel === "upi" || channel === "upi_vip") {
        acc.upi.push(exportLine);
      } else if (channel === "ideal" || channel === "vip") {
        acc.ideal.push(exportLine);
      } else if (channel === "pix" || channel === "pix_vip") {
        acc.pix.push(exportLine);
      }
      return acc;
    },
    { upi: [], ideal: [], pix: [] }
  );
}

export function getPlusExportLine(row) {
  const exportLine = String(row?.exportLine || "").trim();
  const redemptionTimestamp = String(row?.redemptionTimestamp || "").trim();
  if (exportLine) {
    return redemptionTimestamp
      ? replaceOrAppendTimestamp(exportLine, row, redemptionTimestamp)
      : exportLine;
  }

  const fallbackTimestamp =
    redemptionTimestamp || String(row?.subscriptionTimestamp || "").trim();
  if (!row?.email || !row?.password || !row?.twofa || !fallbackTimestamp) return "";
  return [row.email, row.password, row.twofa, fallbackTimestamp].join(DELIMITER);
}
