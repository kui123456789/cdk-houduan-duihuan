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
  },
  {
    id: "kakao_vip",
    label: "KAKAO VIP 通道",
    shortLabel: "KAKAO VIP",
    description: "KAKAO VIP 优先通道卡密池",
    placeholder: "KAKAO-VIP-CDK-001\nKAKAO-VIP-CDK-002"
  },
  {
    id: "kakao",
    label: "KAKAO 排队",
    shortLabel: "KAKAO",
    description: "KAKAO 队列卡密池",
    placeholder: "KAKAO-CDK-001\nKAKAO-CDK-002"
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

function isLikelyTimestamp(value) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}(?:[T\s]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(text) ||
    /^\d{10,13}$/.test(text);
}

function isLikelyAccessTokenStart(value) {
  const text = String(value || "").trim();
  return /^eyJ[\w-]*(?:\.|$)/.test(text) || text.split(".").length >= 3;
}

function rebuildPickupAccountParts(parts, pickupIndex) {
  if (!isLikelyPickupUrl(parts[pickupIndex])) return null;

  const timestampIndex = isLikelyTimestamp(parts.at(-1)) ? parts.length - 1 : parts.length;
  if (timestampIndex <= pickupIndex + 1) return null;

  const detectedTokenIndex = parts.findIndex(
    (part, index) => index > pickupIndex && index < timestampIndex && isLikelyAccessTokenStart(part)
  );
  const tokenIndex = detectedTokenIndex === -1 ? pickupIndex + 1 : detectedTokenIndex;
  const rebuilt = [
    ...parts.slice(0, pickupIndex),
    parts.slice(pickupIndex, tokenIndex).join(DELIMITER),
    parts.slice(tokenIndex, timestampIndex).join(DELIMITER)
  ];
  if (timestampIndex < parts.length) rebuilt.push(parts.at(-1));
  return rebuilt;
}

function splitAccountParts(source) {
  const parts = source.split(DELIMITER).map((part) => part.trim());

  if (
    parts.length >= 5 &&
    !parts[3] &&
    !isLikelyPickupUrl(parts[1])
  ) {
    const hasTimestamp = isLikelyTimestamp(parts.at(-1));
    const credentialEnd = hasTimestamp ? parts.length - 1 : parts.length;
    const rebuilt = [
      ...parts.slice(0, 4),
      parts.slice(4, credentialEnd).join(DELIMITER)
    ];
    if (hasTimestamp) rebuilt.push(parts.at(-1));
    return rebuilt;
  }

  if (
    parts.length === 6 &&
    isLikelyPickupUrl(parts[3]) &&
    isLikelyTimestamp(parts[5])
  ) {
    return parts;
  }

  const fullPickupParts = rebuildPickupAccountParts(parts, 3);
  if (fullPickupParts) return fullPickupParts;

  const shortPickupParts = rebuildPickupAccountParts(parts, 1);
  if (shortPickupParts) return shortPickupParts;

  const hasTimestamp = isLikelyTimestamp(parts.at(-1));
  if (!isLikelyPickupUrl(parts[1]) && !isLikelyAccessTokenStart(parts[1]) && parts.length >= 4) {
    if (hasTimestamp && parts.length > 5) {
      return [...parts.slice(0, 3), parts.slice(3, -1).join(DELIMITER), parts.at(-1)];
    }
    if (!hasTimestamp && parts.length > 4) {
      return [...parts.slice(0, 3), parts.slice(3).join(DELIMITER)];
    }
  }

  if (isLikelyAccessTokenStart(parts[1])) {
    if (hasTimestamp && parts.length > 3) {
      return [parts[0], parts.slice(1, -1).join(DELIMITER), parts.at(-1)];
    }
    if (!hasTimestamp && parts.length > 2) {
      return [parts[0], parts.slice(1).join(DELIMITER)];
    }
  }

  return parts;
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
    if (typeof globalThis.atob !== "function") return null;
    const binary = globalThis.atob(padded);
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

function getJwtPayloadEmail(payload) {
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

export function getAccessTokenEmail(accessToken) {
  return getJwtPayloadEmail(decodeJwtPayload(accessToken));
}

export function classifyAccountCredential(email, credential) {
  const value = String(credential || "").trim();
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const session = parseSessionJson(value);
  if (session) {
    const accessToken = getAccessTokenFromSessionLike(session);
    const sessionToken = getSessionTokenFromSessionLike(session);
    const tokenEmail = String(getEmailFromSessionLike(session, accessToken) || "")
      .trim()
      .toLowerCase();
    if (tokenEmail && tokenEmail !== normalizedEmail) {
      return {
        credentialKind: "invalid",
        credentialValue: value,
        tokenEmail,
        reason: `Session 所属邮箱 ${tokenEmail} 与第 1 段邮箱不一致`
      };
    }
    if (!accessToken && !sessionToken) {
      return {
        credentialKind: "invalid",
        credentialValue: value,
        tokenEmail,
        reason: "Session JSON 中没有 sessionToken 或 accessToken"
      };
    }
    return {
      credentialKind: sessionToken ? "session_token" : "access_token",
      credentialValue: sessionToken || accessToken,
      accessToken,
      sessionToken,
      tokenEmail
    };
  }

  const tokenEmail = getAccessTokenEmail(value);
  if (tokenEmail && tokenEmail !== normalizedEmail) {
    return {
      credentialKind: "invalid",
      credentialValue: value,
      tokenEmail,
      reason: `AT 所属邮箱 ${tokenEmail} 与第 1 段邮箱不一致`
    };
  }
  if (tokenEmail) {
    return {
      credentialKind: "access_token",
      credentialValue: value,
      accessToken: value,
      sessionToken: "",
      tokenEmail
    };
  }
  return {
    credentialKind: "session_token",
    credentialValue: value,
    accessToken: "",
    sessionToken: value,
    tokenEmail: ""
  };
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

function getSessionTokenFromCookie(cookie) {
  const match = String(cookie || "").match(
    /(?:^|;\s*)__Secure-next-auth\.session-token=([^;]+)/i
  );
  return String(match?.[1] || "").trim();
}

export function getSessionTokenFromSessionLike(value) {
  return String(
    value?.sessionToken ||
      value?.session_token ||
      value?.session?.sessionToken ||
      value?.session?.session_token ||
      getSessionTokenFromCookie(value?.cookie) ||
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
  accessToken = "",
  sessionToken = "",
  credentialKind = accessToken ? "access_token" : sessionToken ? "session_token" : "",
  credentialValue = accessToken || sessionToken,
  timestamp = "",
  inputFormat,
  exportParts,
  sourceType = "account"
}) {
  const session = sourceType === "session"
    ? splitAccountParts(source)
        .map((part) => parseSessionJson(part))
        .find(Boolean) || parseSessionJson(source)
    : null;
  return {
    lineNumber,
    source,
    email,
    password,
    twofa,
    pickupUrl,
    accessToken,
    sessionToken,
    credentialKind,
    credentialValue,
    timestamp,
    inputFormat,
    sourceType,
    session,
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
  const parts = splitAccountParts(source);
  const email = parts[0] || "";

  if (![2, 3, 4, 5, 6].includes(parts.length)) {
    return buildFormatError(
      lineNumber,
      source,
      `支持格式：邮箱---密码---2fa---[取件地址---]session/at---[时间戳]；邮箱---[取件地址---]session/at---[时间戳]。取件地址和时间戳均可省略。当前 ${parts.length} 段`
    );
  }

  const emailError = validateEmailPart(lineNumber, source, email);
  if (emailError) return emailError;

  if (parts.length === 6) {
    const [emailValue, password, twofa, pickupUrl, credential, timestamp] = parts;
    const emptyError = validateRequiredParts(lineNumber, source, [emailValue, password, twofa, credential, timestamp], [
      "邮箱",
      "密码",
      "2fa",
      "session/at",
      "时间戳"
    ]);
    if (emptyError) return emptyError;
    if (pickupUrl && !isLikelyPickupUrl(pickupUrl)) {
      return buildFormatError(lineNumber, source, "第 4 段必须是邮箱取件码地址");
    }
    if (!isLikelyTimestamp(timestamp)) {
      return buildFormatError(lineNumber, source, "第 6 段必须是有效时间戳");
    }
    const classified = classifyAccountCredential(emailValue, credential);
    if (classified.credentialKind === "invalid") {
      return buildFormatError(lineNumber, source, classified.reason);
    }

    return {
      account: createAccount({
        lineNumber,
        source,
        email: emailValue,
        password,
        twofa,
        pickupUrl,
        accessToken: classified.accessToken,
        sessionToken: classified.sessionToken,
        credentialKind: classified.credentialKind,
        credentialValue: classified.credentialValue,
        timestamp,
        inputFormat: pickupUrl
          ? classified.credentialKind === "session_token"
            ? "email_password_2fa_pickup_url_session_timestamp"
            : "email_password_2fa_pickup_url_at_timestamp"
          : classified.credentialKind === "session_token"
            ? "email_password_2fa_session_timestamp"
            : "email_password_2fa_at_timestamp",
        sourceType: classified.credentialKind === "session_token" ? "session" : "account",
        exportParts: [emailValue, password, twofa, pickupUrl, timestamp]
      })
    };
  }

  if (parts.length === 5) {
    const [emailValue, password, twofa, fourth, fifth] = parts;
    if (isLikelyPickupUrl(fourth) || !fourth) {
      const emptyError = validateRequiredParts(lineNumber, source, [emailValue, password, twofa, fifth], [
        "邮箱",
        "密码",
        "2fa",
        "session/at"
      ]);
      if (emptyError) return emptyError;
      const classified = classifyAccountCredential(emailValue, fifth);
      if (classified.credentialKind === "invalid") {
        return buildFormatError(lineNumber, source, classified.reason);
      }

      return {
        account: createAccount({
          lineNumber,
          source,
          email: emailValue,
          password,
          twofa,
          pickupUrl: fourth,
          accessToken: classified.accessToken,
          sessionToken: classified.sessionToken,
          credentialKind: classified.credentialKind,
          credentialValue: classified.credentialValue,
          inputFormat: fourth
            ? classified.credentialKind === "session_token"
              ? "email_password_2fa_pickup_url_session"
              : "email_password_2fa_pickup_url_at"
            : classified.credentialKind === "session_token"
              ? "email_password_2fa_session"
              : "email_password_2fa_at",
          sourceType: classified.credentialKind === "session_token" ? "session" : "account",
          exportParts: [emailValue, password, twofa, fourth]
        })
      };
    }

    const emptyError = validateRequiredParts(lineNumber, source, parts, [
      "邮箱",
      "密码",
      "2fa",
      "session/at",
      "时间戳"
    ]);
    if (emptyError) return emptyError;
    if (!isLikelyTimestamp(fifth)) {
      return buildFormatError(lineNumber, source, "第 5 段必须是有效时间戳");
    }
    const classified = classifyAccountCredential(emailValue, fourth);
    if (classified.credentialKind === "invalid") {
      return buildFormatError(lineNumber, source, classified.reason);
    }

    return {
      account: createAccount({
        lineNumber,
        source,
        email: emailValue,
        password,
        twofa,
        accessToken: classified.accessToken,
        sessionToken: classified.sessionToken,
        credentialKind: classified.credentialKind,
        credentialValue: classified.credentialValue,
        timestamp: fifth,
        inputFormat:
          classified.credentialKind === "session_token"
            ? "email_password_2fa_session_timestamp"
            : "email_password_2fa_at_timestamp",
        sourceType: classified.credentialKind === "session_token" ? "session" : "account",
        exportParts: [emailValue, password, twofa, fifth]
      })
    };
  }

  if (parts.length === 4) {
    const [emailValue, second, third, fourth] = parts;
    if (isLikelyPickupUrl(second)) {
      const emptyError = validateRequiredParts(lineNumber, source, parts, [
        "邮箱",
        "邮箱取件码地址",
        "session/at",
        "时间戳"
      ]);
      if (emptyError) return emptyError;
      if (!isLikelyTimestamp(fourth)) {
        return buildFormatError(lineNumber, source, "第 4 段必须是有效时间戳");
      }
      const classified = classifyAccountCredential(emailValue, third);
      if (classified.credentialKind === "invalid") {
        return buildFormatError(lineNumber, source, classified.reason);
      }

      return {
        account: createAccount({
          lineNumber,
          source,
          email: emailValue,
          pickupUrl: second,
          accessToken: classified.accessToken,
          sessionToken: classified.sessionToken,
          credentialKind: classified.credentialKind,
          credentialValue: classified.credentialValue,
          timestamp: fourth,
          inputFormat:
            classified.credentialKind === "session_token"
              ? "email_pickup_url_session_timestamp"
              : "email_pickup_url_at_timestamp",
          sourceType: classified.credentialKind === "session_token" ? "session" : "account",
          exportParts: [emailValue, second, fourth]
        })
      };
    }

    const emptyError = validateRequiredParts(lineNumber, source, parts, [
      "邮箱",
      "密码",
      "2fa",
      "session/at"
    ]);
    if (emptyError) return emptyError;
    const classified = classifyAccountCredential(emailValue, fourth);
    if (classified.credentialKind === "invalid") {
      return buildFormatError(lineNumber, source, classified.reason);
    }
    return {
      account: createAccount({
        lineNumber,
        source,
        email: emailValue,
        password: second,
        twofa: third,
        accessToken: classified.accessToken,
        sessionToken: classified.sessionToken,
        credentialKind: classified.credentialKind,
        credentialValue: classified.credentialValue,
        inputFormat:
          classified.credentialKind === "session_token"
            ? "email_password_2fa_session"
            : "email_password_2fa_at",
        sourceType: classified.credentialKind === "session_token" ? "session" : "account",
        exportParts: [emailValue, second, third]
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
      const classified = classifyAccountCredential(emailValue, third);
      if (classified.credentialKind === "invalid") {
        return buildFormatError(lineNumber, source, classified.reason);
      }
      return {
        account: createAccount({
          lineNumber,
          source,
          email: emailValue,
          pickupUrl: second,
          accessToken: classified.accessToken,
          sessionToken: classified.sessionToken,
          credentialKind: classified.credentialKind,
          credentialValue: classified.credentialValue,
          inputFormat:
            classified.credentialKind === "session_token"
              ? "email_pickup_url_session"
              : "email_pickup_url_at",
          sourceType: classified.credentialKind === "session_token" ? "session" : "account",
          exportParts: [emailValue, second]
        })
      };
    }

    if (!isLikelyTimestamp(third)) {
      return buildFormatError(lineNumber, source, "第 3 段必须是有效时间戳");
    }
    const classified = classifyAccountCredential(emailValue, second);
    if (classified.credentialKind === "invalid") {
      return buildFormatError(lineNumber, source, classified.reason);
    }

    return {
      account: createAccount({
        lineNumber,
        source,
        email: emailValue,
        accessToken: classified.accessToken,
        sessionToken: classified.sessionToken,
        credentialKind: classified.credentialKind,
        credentialValue: classified.credentialValue,
        timestamp: third,
        inputFormat:
          classified.credentialKind === "session_token"
            ? "email_session_timestamp"
            : "email_at_timestamp",
        sourceType: classified.credentialKind === "session_token" ? "session" : "account",
        exportParts: [emailValue, third]
      })
    };
  }

  const [emailValue, credential] = parts;
  const emptyError = validateRequiredParts(lineNumber, source, [emailValue, credential], [
    "邮箱",
    "session/at"
  ]);
  if (emptyError) return emptyError;
  const classified = classifyAccountCredential(emailValue, credential);
  if (classified.credentialKind === "invalid") {
    return buildFormatError(lineNumber, source, classified.reason);
  }

  return {
    account: createAccount({
      lineNumber,
      source,
      email: emailValue,
      accessToken: classified.accessToken,
      sessionToken: classified.sessionToken,
      credentialKind: classified.credentialKind,
      credentialValue: classified.credentialValue,
      inputFormat: classified.credentialKind === "session_token" ? "email_session" : "email_at",
      sourceType: classified.credentialKind === "session_token" ? "session" : "account",
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
      const credentialKey = String(account.credentialValue || "").trim();
      if (credentialKey && seenAccessTokens.has(credentialKey)) {
        duplicateCount += 1;
        errors.push({
          lineNumber,
          source,
          type: "account_duplicate_token",
          reason: `凭证重复，已自动去重；首次出现在第 ${seenAccessTokens.get(credentialKey)} 行`
        });
        return;
      }

      seenEmails.set(emailKey, lineNumber);
      if (credentialKey) seenAccessTokens.set(credentialKey, lineNumber);
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

  const accountParts = splitAccountParts(trimmedSource);
  const looksLikeFullAccount =
    accountParts.length >= 4 ||
    (accountParts.length === 3 &&
      (isLikelyPickupUrl(accountParts[1]) || isLikelyTimestamp(accountParts[2])));
  if (looksLikeFullAccount) {
    const parsedAccount = parseAccountLine(trimmedSource, lineNumber);
    if (parsedAccount.error) return parsedAccount;
    return {
      account: {
        ...parsedAccount.account,
        sourceType: "session"
      },
      refreshOnly: false
    };
  }

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
    if (explicitEmail && sessionRaw) {
      return {
        account: createAccount({
          lineNumber,
          source,
          email: explicitEmail,
          accessToken: "",
          sessionToken: sessionRaw,
          credentialKind: "session_token",
          credentialValue: sessionRaw,
          inputFormat: "email_session_token",
          sourceType: "session",
          exportParts: [explicitEmail]
        }),
        refreshOnly: true
      };
    }
    return buildFormatError(
      lineNumber,
      source,
      "Session 格式必须是 https://chatgpt.com/api/auth/session 返回的 JSON，或 邮箱---session JSON"
    );
  }

  const accessToken = getAccessTokenFromSessionLike(session);
  if (!accessToken) return buildFormatError(lineNumber, source, "Session 中没有 accessToken");
  const sessionToken = getSessionTokenFromSessionLike(session);

  const email = explicitEmail || getEmailFromSessionLike(session, accessToken);
  if (!isValidEmail(email)) {
    return buildFormatError(lineNumber, source, "Session 中没有可识别的邮箱");
  }

  const timestamp = String(session.expires || session.expiresAt || session.expiry || "").trim();
  const credentialKind = sessionToken ? "session_token" : "access_token";
  return {
    account: createAccount({
      lineNumber,
      source,
      email,
      accessToken,
      sessionToken,
      credentialKind,
      credentialValue: sessionToken || accessToken,
      timestamp,
      inputFormat: "chatgpt_session_json",
      sourceType: "session",
      exportParts: [email, timestamp]
    }),
    refreshOnly: false
  };
}

export function updateAccountSourceSessionToken(source, sessionToken) {
  const nextSessionToken = String(sessionToken || "").trim();
  if (!nextSessionToken) return String(source || "").trim();
  const parts = splitAccountParts(String(source || "").trim());
  let credentialIndex = -1;
  if (parts.length === 6 && (isLikelyPickupUrl(parts[3]) || !parts[3])) credentialIndex = 4;
  else if (parts.length === 5 && (isLikelyPickupUrl(parts[3]) || !parts[3])) credentialIndex = 4;
  else if (parts.length === 5) credentialIndex = 3;
  else if (parts.length === 4 && isLikelyPickupUrl(parts[1])) credentialIndex = 2;
  else if (parts.length === 4) credentialIndex = 3;
  else if (parts.length === 3 && isLikelyPickupUrl(parts[1])) credentialIndex = 2;
  else if (parts.length === 3) credentialIndex = 1;
  else if (parts.length === 2) credentialIndex = 1;
  if (credentialIndex < 0) return String(source || "").trim();
  parts[credentialIndex] = nextSessionToken;
  return parts.join(DELIMITER);
}

export function updateSessionSourceCredentials(source, refreshResult = {}) {
  const trimmedSource = String(source || "").trim();
  const accountParts = splitAccountParts(trimmedSource);
  const looksLikeFullAccount =
    accountParts.length >= 4 ||
    (accountParts.length === 3 &&
      (isLikelyPickupUrl(accountParts[1]) || isLikelyTimestamp(accountParts[2])));
  if (looksLikeFullAccount && !parseAccountLine(trimmedSource, 1).error) {
    const sessionToken = String(refreshResult.sessionToken || "").trim();
    return sessionToken
      ? updateAccountSourceSessionToken(trimmedSource, sessionToken)
      : trimmedSource;
  }

  let prefix = "";
  let sessionRaw = trimmedSource;
  const delimiterIndex = trimmedSource.indexOf(DELIMITER);
  if (delimiterIndex > 0) {
    const maybeEmail = trimmedSource.slice(0, delimiterIndex).trim();
    if (isValidEmail(maybeEmail)) {
      prefix = `${maybeEmail}${DELIMITER}`;
      sessionRaw = trimmedSource.slice(delimiterIndex + DELIMITER.length).trim();
    }
  }
  const session = parseSessionJson(sessionRaw);
  if (!session) {
    const sessionToken = String(refreshResult.sessionToken || "").trim();
    return prefix && sessionToken ? `${prefix}${sessionToken}` : trimmedSource;
  }

  const accessToken = String(refreshResult.accessToken || "").trim();
  const sessionToken = String(refreshResult.sessionToken || "").trim();
  const expires = String(refreshResult.expires || "").trim();
  return `${prefix}${JSON.stringify({
    ...session,
    ...(accessToken ? { accessToken } : {}),
    ...(sessionToken ? { sessionToken } : {}),
    ...(expires ? { expires } : {})
  })}`;
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

    const session = {
      ...parsed.account,
      refreshOnly: parsed.refreshOnly === true
    };
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
    if (tokenKey && seenAccessTokens.has(tokenKey)) {
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
    if (tokenKey) seenAccessTokens.set(tokenKey, lineNumber);
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
        if (sourceType === "session" && account?.refreshOnly === true) return;
        const emailKey = String(account?.email || "").trim().toLowerCase();
        const tokenKey = String(
          account?.credentialValue || account?.sessionToken || account?.accessToken || ""
        ).trim();
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
        if (tokenKey) {
          seenAccessTokens.set(tokenKey, sourceIndex + 1);
        }
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
