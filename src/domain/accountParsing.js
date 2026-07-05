export const DELIMITER = "---";
export const MAX_BATCH_SIZE = 100;
export const CDK_POOLS = [
  {
    id: "vip",
    label: "VIP 通道",
    shortLabel: "VIP",
    description: "优先通道卡密池",
    placeholder: "VIP-CDK-001\nVIP-CDK-002"
  },
  {
    id: "ideal",
    label: "IDEAL 排队",
    shortLabel: "IDEAL",
    description: "IDEAL 队列卡密池",
    placeholder: "IDEAL-CDK-001\nIDEAL-CDK-002"
  },
  {
    id: "upi",
    label: "UPI 排队",
    shortLabel: "UPI",
    description: "UPI 队列卡密池",
    placeholder: "UPI-CDK-001\nUPI-CDK-002"
  }
];

export function appendImportedText(current, imported) {
  const nextText = String(imported || "").replace(/^\ufeff/, "");
  if (!nextText.trim()) return current;
  if (!String(current || "").trim()) return nextText;
  const prefix = String(current);
  const separator = /\r?\n$/.test(prefix) ? "" : "\n";
  return `${prefix}${separator}${nextText.replace(/^(\r?\n)+/, "")}`;
}

function parseAccountLine(source, lineNumber) {
  const parts = source.split(DELIMITER).map((part) => part.trim());
  if (parts.length !== 5) {
    return {
      error: {
        lineNumber,
        source,
        reason: `账号必须是 5 段：邮箱---密码---2fa---at---时间戳，当前 ${parts.length} 段`
      }
    };
  }

  const emptyIndex = parts.findIndex((part) => !part);
  if (emptyIndex !== -1) {
    return {
      error: {
        lineNumber,
        source,
        reason: `第 ${emptyIndex + 1} 段不能为空`
      }
    };
  }

  const [email, password, twofa, accessToken, timestamp] = parts;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return {
      error: {
        lineNumber,
        source,
        reason: "第 1 段必须是邮箱"
      }
    };
  }

  return {
    account: {
      lineNumber,
      source,
      email,
      password,
      twofa,
      accessToken,
      timestamp,
      exportLine: [email, password, twofa, timestamp].join(DELIMITER)
    }
  };
}

function collectAccounts(text, options = {}) {
  const accounts = [];
  const errors = [];
  const outputLines = [];
  const seenEmails = new Map();
  const seenAccessTokens = new Map();
  let duplicateCount = 0;
  let invalidCount = 0;

  String(text || "")
    .split(/\r?\n/)
    .forEach((rawLine, index) => {
      const lineNumber = index + 1;
      const source = rawLine.trim();
      if (!source) return;

      const parsed = parseAccountLine(source, lineNumber);
      if (parsed.error) {
        invalidCount += 1;
        errors.push({ ...parsed.error, type: "account_format" });
        if (options.keepRejectedLines) outputLines.push(source);
        return;
      }

      const account = parsed.account;
      const emailKey = account.email.toLowerCase();
      if (seenEmails.has(emailKey)) {
        duplicateCount += 1;
        errors.push({
          lineNumber,
          source,
          type: "account_duplicate",
          reason: `账号重复，已自动去重；首次出现在第 ${seenEmails.get(emailKey)} 行`
        });
        return;
      }
      const tokenKey = account.accessToken.trim();
      if (seenAccessTokens.has(tokenKey)) {
        duplicateCount += 1;
        errors.push({
          lineNumber,
          source,
          type: "account_duplicate_token",
          reason: `AT 重复，已自动去重；首次出现在第 ${seenAccessTokens.get(tokenKey)} 行`
        });
        return;
      }

      seenEmails.set(emailKey, lineNumber);
      seenAccessTokens.set(tokenKey, lineNumber);
      accounts.push(account);
      if (options.keepInvalidLines) outputLines.push(account.source);
    });

  return {
    accounts,
    errors,
    text: outputLines.join("\n"),
    accountCount: accounts.length,
    duplicateCount,
    invalidCount
  };
}

export function normalizeAccountText(text) {
  return collectAccounts(text, { keepInvalidLines: true });
}

export function inspectAccountText(text) {
  return collectAccounts(text, { keepInvalidLines: true, keepRejectedLines: true });
}

export function parseAccounts(text) {
  const { accounts, errors } = collectAccounts(text);
  return { accounts, errors };
}

export function parseCdkeys(text) {
  return parseCdkeyPools(text);
}

export function parseCdkeyPools(input) {
  const cdkeys = [];
  const errors = [];
  const seen = new Map();

  normalizeCdkeyInput(input).forEach((pool) => {
    String(pool.text || "")
      .split(/\r?\n/)
      .forEach((rawLine, index) => {
        const lineNumber = index + 1;
        const cdkey = rawLine.trim();
        if (!cdkey) return;

        if (seen.has(cdkey)) {
          const first = seen.get(cdkey);
          errors.push({
            lineNumber,
            source: cdkey,
            poolId: pool.id,
            poolLabel: pool.label,
            reason: `CDK 重复，首次出现在 ${first.poolLabel} 第 ${first.lineNumber} 行`
          });
          return;
        }

        seen.set(cdkey, { lineNumber, poolLabel: pool.label });
        cdkeys.push({
          lineNumber,
          cdkey,
          source: cdkey,
          channel: pool.id,
          channelLabel: pool.label,
          poolId: pool.id,
          poolLabel: pool.label
        });
      });
  });

  return { cdkeys, errors };
}

function normalizeCdkeyInput(input) {
  if (typeof input === "string") {
    return [{ id: "default", label: "CDK", text: input }];
  }

  if (Array.isArray(input)) {
    return input.map((pool, index) => ({
      id: pool.id || `pool-${index + 1}`,
      label: pool.label || pool.title || `卡密池 ${index + 1}`,
      text: pool.text || pool.value || ""
    }));
  }

  const source = input && typeof input === "object" ? input : {};
  const knownPools = CDK_POOLS.map((pool) => ({
    id: pool.id,
    label: pool.label,
    text: source[pool.id] || ""
  }));
  const extraPools = Object.keys(source)
    .filter((key) => !CDK_POOLS.some((pool) => pool.id === key))
    .map((key) => ({
      id: key,
      label: key,
      text: source[key] || ""
    }));

  return [...knownPools, ...extraPools];
}
