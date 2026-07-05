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
  exportParts
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
