function normalizeAccessToken(value) {
  return String(value || "").trim();
}

function assertUniqueSubmitAccessTokens(rows) {
  const seen = new Set();
  for (const row of rows || []) {
    const accessToken = normalizeAccessToken(row?.accessToken);
    if (!accessToken) continue;
    if (seen.has(accessToken)) {
      throw new Error("提交被拦截：同一 AT 不能同时提交多张卡密");
    }
    seen.add(accessToken);
  }
}

export function buildSubmitCommand(rows) {
  assertUniqueSubmitAccessTokens(rows);
  const command = {
    path: "/api/redeem/submit",
    body: {
      items: rows.map((row) => ({
        cdkey: row.cdkey,
        access_token: row.accessToken,
        channel: row.channel
      }))
    }
  };
  if ((rows || []).length && rows.every((row) => row?.sourceType === "session")) {
    command.options = { credentialMode: "session" };
  }
  return command;
}

export function buildStatusQueryCommand(cdkeys) {
  return {
    path: "/api/redeem/status",
    body: { cdkeys }
  };
}

export function buildAutoCycleCommand({ cdkey, channel, account }) {
  return buildSubmitCommand([
    {
      cdkey,
      channel,
      accessToken: account.accessToken,
      sourceType: account.sourceType
    }
  ]);
}
