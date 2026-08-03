import { DELIMITER } from "./accountParsing.js";
import { isReleaseVerifiedAccount } from "./sessionCredentials.js";

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
      if (
        !isReleaseVerifiedAccount(row) ||
        !exportLine
      ) return acc;
      const channel = String(row.channel || "").trim().toLowerCase();
      if (channel === "upi" || channel === "upi_vip") {
        acc.upi.push(exportLine);
      } else if (channel === "ideal" || channel === "vip") {
        acc.ideal.push(exportLine);
      } else if (channel === "pix" || channel === "pix_vip") {
        acc.pix.push(exportLine);
      } else if (channel === "kakao" || channel === "kakao_vip") {
        acc.kakao.push(exportLine);
      }
      return acc;
    },
    { upi: [], ideal: [], pix: [], kakao: [] }
  );
}

export function getPlusExportLine(row) {
  const exportLine = String(row?.exportLine || "").trim();
  const redemptionTimestamp = String(row?.redemptionTimestamp || "").trim();
  if (!redemptionTimestamp) return "";
  if (exportLine) {
    return replaceOrAppendTimestamp(exportLine, row, redemptionTimestamp);
  }

  if (!row?.email || !row?.password || !row?.twofa) return "";
  return [row.email, row.password, row.twofa, redemptionTimestamp].join(DELIMITER);
}
