function normalizeCdkey(value) {
  return String(value || "").trim();
}

function isSessionRow(row) {
  return row?.sourceType === "session";
}

export function splitRowsByCredential(rows, { hasUserApiKey = false } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (hasUserApiKey) {
    return {
      groups: list.length ? [{ credentialMode: "", rows: list }] : [],
      blockedRows: []
    };
  }

  const sessionRows = list.filter(isSessionRow);
  const blockedRows = list.filter((row) => !isSessionRow(row));
  return {
    groups: sessionRows.length ? [{ credentialMode: "session", rows: sessionRows }] : [],
    blockedRows
  };
}

export function splitCdkeysByCredential(
  rows,
  cdkeys,
  { hasUserApiKey = false } = {}
) {
  const cleanCdkeys = [
    ...new Set((Array.isArray(cdkeys) ? cdkeys : []).map(normalizeCdkey).filter(Boolean))
  ];
  if (hasUserApiKey) {
    return {
      groups: cleanCdkeys.length ? [{ credentialMode: "", cdkeys: cleanCdkeys }] : [],
      blockedCdkeys: []
    };
  }

  const requestedCdkeys = new Set(cleanCdkeys);
  const ownersByCdkey = new Map();
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const cdkey = normalizeCdkey(row?.cdkey);
    if (!requestedCdkeys.has(cdkey)) return;
    const current = ownersByCdkey.get(cdkey);
    if (
      !current ||
      row?.statusOwner === true ||
      (current?.statusOwner !== true && row?.statusOwner !== false)
    ) {
      ownersByCdkey.set(cdkey, row);
    }
  });

  const sessionCdkeys = [];
  const blockedCdkeys = [];
  cleanCdkeys.forEach((cdkey) => {
    if (isSessionRow(ownersByCdkey.get(cdkey))) {
      sessionCdkeys.push(cdkey);
    } else {
      blockedCdkeys.push(cdkey);
    }
  });

  return {
    groups: sessionCdkeys.length
      ? [{ credentialMode: "session", cdkeys: sessionCdkeys }]
      : [],
    blockedCdkeys
  };
}

export function mergeProxyPayloads(payloads) {
  const list = (Array.isArray(payloads) ? payloads : []).filter(Boolean);
  const backends = list.map((payload) => payload.backend).filter(Boolean);
  return {
    ok: list.every((payload) => payload.ok !== false),
    batchCount: list.reduce((total, payload) => total + Number(payload.batchCount || 0), 0),
    items: list.flatMap((payload) => (Array.isArray(payload.items) ? payload.items : [])),
    backend: {
      emptyResponse:
        backends.length > 0 && backends.every((backend) => backend.emptyResponse === true),
      emptyBatchCount: backends.reduce(
        (total, backend) => total + Number(backend.emptyBatchCount || 0),
        0
      ),
      itemCount: backends.reduce(
        (total, backend) => total + Number(backend.itemCount || 0),
        0
      ),
      batches: backends.flatMap((backend) =>
        Array.isArray(backend.batches) ? backend.batches : []
      )
    }
  };
}
