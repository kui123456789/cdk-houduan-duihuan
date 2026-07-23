export const DELIMITER = "---";
export const MAX_BATCH_SIZE = 100;
export const CDK_POOLS = [
  {
    id: "vip",
    label: "IDEAL VIP 通道",
    shortLabel: "IDEAL VIP",
    description: "IDEAL VIP 优先通道卡密池",
    placeholder: "IDEAL-VIP-CDK-001\nIDEAL-VIP-CDK-002"
  },
  {
    id: "ideal",
    label: "IDEAL 排队",
    shortLabel: "IDEAL",
    description: "IDEAL 队列卡密池",
    placeholder: "IDEAL-CDK-001\nIDEAL-CDK-002"
  },
  {
    id: "upi_vip",
    label: "UPI VIP 通道",
    shortLabel: "UPI VIP",
    description: "UPI VIP 优先通道卡密池",
    placeholder: "UPI-VIP-CDK-001\nUPI-VIP-CDK-002"
  },
  {
    id: "upi",
    label: "UPI 排队",
    shortLabel: "UPI",
    description: "UPI 队列卡密池",
    placeholder: "UPI-CDK-001\nUPI-CDK-002"
  },
  {
    id: "pix_vip",
    label: "PIX VIP 通道",
    shortLabel: "PIX VIP",
    description: "PIX VIP 优先通道卡密池",
    placeholder: "PIX-VIP-CDK-001\nPIX-VIP-CDK-002"
  },
  {
    id: "pix",
    label: "PIX 排队",
    shortLabel: "PIX",
    description: "PIX 队列卡密池",
    placeholder: "PIX-CDK-001\nPIX-CDK-002"
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

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function isLikelyPickupUrl(value) {
  const text = String(value || "").trim();
  return /^https?:\/\//i.test(text) || /^mailto:/i.test(text);
}

function joinExportParts(parts) {
  return parts.map((part) => String(part || "").trim()).filter(Boolean).join(DELIMITER);
}

function decodeJwtPayload(token) {
  const parts = String(token || "").split(".");
  if (parts.length < 2) return null;
  try {
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload.padEnd(Math.ceil(payload.length / 4) * 4, "=");
    const binary =
      typeof atob === "function"
        ? atob(padded)
        : Buffer.from(padded, "base64").toString("binary");
    const json = decodeURIComponent(
      Array.from(binary)
        .map((char) => `%${char.charCodeAt(0).toString(16).padStart(2, "0")}`)
        .join("")
    );
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export function getAccessTokenEmail(accessToken) {
  const payload = decodeJwtPayload(accessToken);
  const candidates = [
    payload?.["https://api.openai.com/profile"]?.email,
    payload?.user?.email,
    payload?.account?.email,
    payload?.profile?.email,
    payload?.email
  ];
  const email = candidates.find(isValidEmail);
  return email ? String(email).trim().toLowerCase() : "";
}

function getEmailFromSessionLike(value, fallbackToken = "") {
  const candidates = [
    value?.user?.email,
    value?.account?.email,
    value?.profile?.email,
    value?.email,
    value?.["https://api.openai.com/profile"]?.email
  ];
  const direct = candidates.find(isValidEmail);
  if (direct) return String(direct).trim();

  return getAccessTokenEmail(fallbackToken);
}

function getAccessTokenFromSessionLike(value) {
  return String(
    value?.accessToken ||
      value?.access_token ||
      value?.token ||
      value?.session?.accessToken ||
      value?.session?.access_token ||
      ""
  ).trim();
}

function createAccount({
  lineNumber,
  source,
  email,
  password = "",
  twofa = "",
  pickupUrl = "",
  accessToken,
  timestamp = "",
  inputFormat,
  exportParts,
  sourceType = "account"
}) {
  return {
    lineNumber,
    source,
    email,
    password,
    twofa,
    pickupUrl,
    accessToken,
    timestamp,
    inputFormat,
    sourceType,
    exportLine: joinExportParts(exportParts)
  };
}

function buildFormatError(lineNumber, source, reason) {
  return {
    error: {
      lineNumber,
      source,
      reason
    }
  };
}

function validateRequiredParts(lineNumber, source, parts, labels) {
  const emptyIndex = parts.findIndex((part) => !part);
  if (emptyIndex === -1) return null;
  return buildFormatError(lineNumber, source, `${labels[emptyIndex] || `第 ${emptyIndex + 1} 段`}不能为空`);
}

function validateEmailPart(lineNumber, source, email) {
  if (isValidEmail(email)) return null;
  return buildFormatError(lineNumber, source, "第 1 段必须是邮箱");
}

function parseAccountLine(source, lineNumber) {
  const parts = source.split(DELIMITER).map((part) => part.trim());
  const email = parts[0] || "";

  if (![2, 3, 4, 5, 6].includes(parts.length)) {
    return buildFormatError(
      lineNumber,
      source,
      `支持格式：邮箱---邮箱取件码地址---at---时间戳；邮箱---密码---2fa---邮箱取件码地址---at---时间戳；邮箱---密码---PASSKEY:xxx---邮箱取件码地址---at---时间戳；邮箱---密码---2fa---at---时间戳；邮箱---at。当前 ${parts.length} 段`
    );
  }

  const emailError = validateEmailPart(lineNumber, source, email);
  if (emailError) return emailError;

  if (parts.length === 6) {
    const [emailValue, password, twofa, pickupUrl, accessToken, timestamp] = parts;
    const emptyError = validateRequiredParts(lineNumber, source, parts, [
      "邮箱",
      "密码",
      "2fa",
      "邮箱取件码地址",
      "at",
      "时间戳"
    ]);
    if (emptyError) return emptyError;
    if (!isLikelyPickupUrl(pickupUrl)) {
      return buildFormatError(lineNumber, source, "第 4 段必须是邮箱取件码地址");
    }

    return {
      account: createAccount({
        lineNumber,
        source,
        email: emailValue,
        password,
        twofa,
        pickupUrl,
        accessToken,
        timestamp,
        inputFormat: "email_password_2fa_pickup_url_at_timestamp",
        exportParts: [emailValue, password, twofa, pickupUrl, timestamp]
      })
    };
  }

  if (parts.length === 5) {
    const [emailValue, password, twofa, accessToken, timestamp] = parts;
    if (isLikelyPickupUrl(accessToken)) {
      const emptyError = validateRequiredParts(lineNumber, source, parts, [
        "邮箱",
        "密码",
        "2fa",
        "邮箱取件码地址",
        "at"
      ]);
      if (emptyError) return emptyError;

      return {
        account: createAccount({
          lineNumber,
          source,
          email: emailValue,
          password,
          twofa,
          pickupUrl: accessToken,
          accessToken: timestamp,
          inputFormat: "email_password_2fa_pickup_url_at",
          exportParts: [emailValue, password, twofa, accessToken]
        })
      };
    }

    const emptyError = validateRequiredParts(lineNumber, source, parts, [
      "邮箱",
      "密码",
      "2fa",
      "at",
      "时间戳"
    ]);
    if (emptyError) return emptyError;

    return {
      account: createAccount({
        lineNumber,
        source,
        email: emailValue,
        password,
        twofa,
        accessToken,
        timestamp,
        inputFormat: "legacy_5",
        exportParts: [emailValue, password, twofa, timestamp]
      })
    };
  }

  if (parts.length === 4) {
    const [emailValue, pickupUrl, accessToken, timestamp] = parts;
    const emptyError = validateRequiredParts(lineNumber, source, [emailValue, pickupUrl, accessToken], [
      "邮箱",
      "邮箱取件码地址",
      "at"
    ]);
    if (emptyError) return emptyError;
    if (!isLikelyPickupUrl(pickupUrl)) {
      return buildFormatError(lineNumber, source, "第 2 段必须是邮箱取件码地址");
    }

    return {
      account: createAccount({
        lineNumber,
        source,
        email: emailValue,
        pickupUrl,
        accessToken,
        timestamp,
        inputFormat: "email_pickup_url_at_timestamp",
        exportParts: [emailValue, pickupUrl, timestamp]
      })
    };
  }

  if (parts.length === 3) {
    const [emailValue, second, third] = parts;
    const emptyError = validateRequiredParts(lineNumber, source, [emailValue, second, third], [
      "邮箱",
      "第 2 段",
      "第 3 段"
    ]);
    if (emptyError) return emptyError;

    if (isLikelyPickupUrl(second)) {
      return {
        account: createAccount({
          lineNumber,
          source,
          email: emailValue,
          pickupUrl: second,
          accessToken: third,
          inputFormat: "email_pickup_url_at",
          exportParts: [emailValue, second]
        })
      };
    }

    return {
      account: createAccount({
        lineNumber,
        source,
        email: emailValue,
        accessToken: second,
        timestamp: third,
        inputFormat: "email_at_timestamp",
        exportParts: [emailValue, third]
      })
    };
  }

  const [emailValue, accessToken] = parts;
  const emptyError = validateRequiredParts(lineNumber, source, [emailValue, accessToken], [
    "邮箱",
    "at"
  ]);
  if (emptyError) return emptyError;

  return {
    account: createAccount({
      lineNumber,
      source,
      email: emailValue,
      accessToken,
      inputFormat: "email_at",
      exportParts: [emailValue]
    })
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

function parseSessionJson(rawValue) {
  try {
    const parsed = JSON.parse(String(rawValue || "").trim());
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

function parseSessionLine(source, lineNumber) {
  const trimmedSource = String(source || "").trim();
  if (!trimmedSource) return null;

  let explicitEmail = "";
  let sessionRaw = trimmedSource;
  const delimiterIndex = trimmedSource.indexOf(DELIMITER);
  if (delimiterIndex > 0) {
    const maybeEmail = trimmedSource.slice(0, delimiterIndex).trim();
    if (isValidEmail(maybeEmail)) {
      explicitEmail = maybeEmail;
      sessionRaw = trimmedSource.slice(delimiterIndex + DELIMITER.length).trim();
    }
  }

  const session = parseSessionJson(sessionRaw);
  if (!session) {
    return buildFormatError(
      lineNumber,
      source,
      "Session 格式必须是 https://chatgpt.com/api/auth/session 返回的 JSON，或 邮箱---session JSON"
    );
  }

  const accessToken = getAccessTokenFromSessionLike(session);
  if (!accessToken) return buildFormatError(lineNumber, source, "Session 中没有 accessToken");

  const email = explicitEmail || getEmailFromSessionLike(session, accessToken);
  if (!isValidEmail(email)) {
    return buildFormatError(lineNumber, source, "Session 中没有可识别的邮箱");
  }

  const timestamp = String(session.expires || session.expiresAt || session.expiry || "").trim();
  return {
    account: createAccount({
      lineNumber,
      source,
      email,
      accessToken,
      timestamp,
      inputFormat: "chatgpt_session_json",
      sourceType: "session",
      exportParts: [email, timestamp]
    })
  };
}

function collectSessions(text, options = {}) {
  const sessions = [];
  const errors = [];
  const outputLines = [];
  const seenEmails = new Map();
  const seenAccessTokens = new Map();
  let duplicateCount = 0;
  let invalidCount = 0;

  const rawText = String(text || "").replace(/^\ufeff/, "").trim();
  const rawEntries = [];
  if (rawText) {
    if (parseSessionJson(rawText)) {
      rawEntries.push({ source: rawText, lineNumber: 1 });
    } else {
      rawText.split(/\r?\n/).forEach((rawLine, index) => {
        const source = rawLine.trim();
        if (source) rawEntries.push({ source, lineNumber: index + 1 });
      });
    }
  }

  rawEntries.forEach(({ source, lineNumber }) => {
    const parsed = parseSessionLine(source, lineNumber);
    if (!parsed || parsed.error) {
      invalidCount += 1;
      errors.push({ ...(parsed?.error || buildFormatError(lineNumber, source, "Session 为空").error), type: "session_format" });
      if (options.keepRejectedLines) outputLines.push(source);
      return;
    }

    const session = parsed.account;
    const emailKey = session.email.toLowerCase();
    if (seenEmails.has(emailKey)) {
      duplicateCount += 1;
      errors.push({
        lineNumber,
        source,
        type: "session_duplicate",
        reason: `Session 邮箱重复，已自动去重；首次出现在第 ${seenEmails.get(emailKey)} 行`
      });
      return;
    }
    const tokenKey = session.accessToken.trim();
    if (seenAccessTokens.has(tokenKey)) {
      duplicateCount += 1;
      errors.push({
        lineNumber,
        source,
        type: "session_duplicate_token",
        reason: `Session AT 重复，已自动去重；首次出现在第 ${seenAccessTokens.get(tokenKey)} 行`
      });
      return;
    }

    seenEmails.set(emailKey, lineNumber);
    seenAccessTokens.set(tokenKey, lineNumber);
    sessions.push(session);
    if (options.keepInvalidLines) outputLines.push(session.source);
  });

  return {
    sessions,
    accounts: sessions,
    errors,
    text: outputLines.join("\n"),
    sessionCount: sessions.length,
    accountCount: sessions.length,
    duplicateCount,
    invalidCount
  };
}

export function normalizeAccountText(text) {
  return collectAccounts(text, { keepInvalidLines: true });
}

export function normalizeSessionText(text) {
  return collectSessions(text, { keepInvalidLines: true });
}

export function mergeAccountSources(...sources) {
  const accounts = [];
  const errors = [];
  const seenEmails = new Map();
  const seenAccessTokens = new Map();
  const sourceCounts = { account: 0, session: 0 };
  let duplicateCount = 0;
  let invalidCount = 0;

  sources
    .filter(Boolean)
    .forEach((sourceResult, sourceIndex) => {
      errors.push(...(sourceResult.errors || []));
      duplicateCount += Number(sourceResult.duplicateCount || 0);
      invalidCount += Number(sourceResult.invalidCount || 0);

      (sourceResult.accounts || sourceResult.sessions || []).forEach((account) => {
        const sourceType = account?.sourceType === "session" ? "session" : "account";
        const emailKey = String(account?.email || "").trim().toLowerCase();
        const tokenKey = String(account?.accessToken || "").trim();
        const lineNumber = account?.lineNumber;
        const source = account?.source || account?.email || "";

        if (emailKey && seenEmails.has(emailKey)) {
          duplicateCount += 1;
          errors.push({
            lineNumber,
            source,
            type: `${sourceType}_duplicate`,
            reason: `${sourceType === "session" ? "Session 邮箱" : "账号"}重复，已跳过；首次来自第 ${seenEmails.get(emailKey)} 个输入池`
          });
          return;
        }
        if (tokenKey && seenAccessTokens.has(tokenKey)) {
          duplicateCount += 1;
          errors.push({
            lineNumber,
            source,
            type: `${sourceType}_duplicate_token`,
            reason: `${sourceType === "session" ? "Session AT" : "账号 AT"}重复，已跳过，避免同一账号消耗多张卡密`
          });
          return;
        }

        if (emailKey) seenEmails.set(emailKey, sourceIndex + 1);
        if (tokenKey) seenAccessTokens.set(tokenKey, sourceIndex + 1);
        accounts.push(account);
        sourceCounts[sourceType] = (sourceCounts[sourceType] || 0) + 1;
      });
    });

  return {
    accounts,
    errors,
    accountCount: accounts.length,
    duplicateCount,
    invalidCount,
    sourceCounts
  };
}

export function inspectAccountText(text) {
  return collectAccounts(text, { keepInvalidLines: true, keepRejectedLines: true });
}

export function parseAccounts(text) {
  const { accounts, errors } = collectAccounts(text);
  return { accounts, errors };
}

export function parseSessions(text) {
  const { sessions, errors } = collectSessions(text);
  return { sessions, accounts: sessions, errors };
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
