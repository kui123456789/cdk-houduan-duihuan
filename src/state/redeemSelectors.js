export function getLatestRowsByCdkey(rowList) {
  const latestByCdkey = new Map();
  (rowList || []).forEach((row) => {
    const cdkey = String(row?.cdkey || "").trim();
    if (!cdkey) return;
    const current = latestByCdkey.get(cdkey);
    if (current?.statusOwner === true && row?.statusOwner !== true) return;
    latestByCdkey.set(cdkey, row);
  });
  return [...latestByCdkey.values()];
}

export function computeCdkUsageStats(cdkeys, rows, formatRowLine) {
  const uniqueRows = getLatestRowsByCdkey(rows);
  const cdkeyItems = (cdkeys || [])
    .map((item) => ({
      cdkey: String(item?.cdkey || "").trim(),
      channelLabel: item?.channelLabel || item?.poolLabel || item?.channel || ""
    }))
    .filter((item) => item.cdkey);
  const cdkeyValues = new Set(cdkeyItems.map((item) => item.cdkey));
  const currentPoolRows = uniqueRows.filter((row) => cdkeyValues.has(String(row?.cdkey || "").trim()));
  const usedRows = currentPoolRows.filter((row) => String(row?.status || "") === "success");
  const successCountByEmail = new Map();
  usedRows.forEach((row) => {
    const email = String(row?.email || "").trim().toLowerCase();
    if (!email) return;
    successCountByEmail.set(email, (successCountByEmail.get(email) || 0) + 1);
  });
  const duplicateSuccessEmailCount = [...successCountByEmail.values()].filter((count) => count > 1)
    .length;
  const displayUsedRows = usedRows.map((row) => {
    const email = String(row?.email || "").trim().toLowerCase();
    return {
      ...row,
      cdkSuccessEmailCount: email ? successCountByEmail.get(email) || 0 : 0
    };
  });
  const usedCdkeys = new Set(usedRows.map((row) => String(row?.cdkey || "").trim()).filter(Boolean));
  const unusedItems = cdkeyItems.filter((item) => !usedCdkeys.has(item.cdkey));
  const total = cdkeyValues.size;

  return {
    total,
    checked: currentPoolRows.length,
    usedCount: usedRows.length,
    unusedCount: Math.max(total - usedRows.length, 0),
    duplicateSuccessEmailCount,
    usedText: displayUsedRows.map(formatRowLine).join("\n"),
    unusedText: unusedItems
      .map((item) => `${item.cdkey}${item.channelLabel ? ` · ${item.channelLabel}` : ""}`)
      .join("\n")
  };
}

export function computeRequestStatusCounts(statusCounts) {
  return {
    waiting:
      (statusCounts.local_ready || 0) +
      (statusCounts.submitting || 0) +
      (statusCounts.pending_dispatch || 0) +
      (statusCounts.queued || 0) +
      (statusCounts.submitted || 0),
    dispatched: (statusCounts.dispatched || 0) + (statusCounts.dispatching || 0),
    running: (statusCounts.running || 0) + (statusCounts.processing || 0),
    failed:
      (statusCounts.failed || 0) +
      (statusCounts.rejected || 0) +
      (statusCounts.invalid || 0) +
      (statusCounts.approve_blocked || 0) +
      (statusCounts.pm_unavailable || 0) +
      (statusCounts.awaiting_payment_expiry || 0)
  };
}
