import { DELIMITER } from "./accountParsing.js";

export function getSuccessExportsByPool(rows) {
  return rows.reduce(
    (acc, row) => {
      const exportLine = getPlusExportLine(row);
      if (row.status !== "success" || row.isPlus !== true || !exportLine) return acc;
      const channel = String(row.channel || "").trim().toLowerCase();
      if (channel === "upi") {
        acc.upi.push(exportLine);
      } else if (channel === "ideal" || channel === "vip") {
        acc.ideal.push(exportLine);
      }
      return acc;
    },
    { upi: [], ideal: [] }
  );
}

export function getPlusExportLine(row) {
  const subscriptionTimestamp = String(row?.subscriptionTimestamp || "").trim();
  if (!row?.email || !row?.password || !row?.twofa || !subscriptionTimestamp) return "";
  return [row.email, row.password, row.twofa, subscriptionTimestamp].join(DELIMITER);
}
