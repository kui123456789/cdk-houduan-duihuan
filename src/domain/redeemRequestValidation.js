export const REDEEM_REQUEST_LIMITS = Object.freeze({
  maxItems: 500,
  cdkey: 256,
  channel: 64,
  accessToken: 16_384,
  apiKey: 4_096
});

export class RedeemRequestValidationError extends Error {
  constructor(message) {
    super(`请求格式无效：${message}`);
    this.name = "RedeemRequestValidationError";
    this.status = 400;
    this.code = "INVALID_REQUEST";
  }
}

export function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalid(message) {
  throw new RedeemRequestValidationError(message);
}

function validateString(value, field, maxLength) {
  if (typeof value !== "string" || !value.trim()) invalid(`${field} 不能为空`);
  if (value.length > maxLength) invalid(`${field} 超过 ${maxLength} 字符上限`);
}

function validateCommon(body) {
  if (!isPlainObject(body)) invalid("请求体必须是普通 JSON 对象");
  if (body.apiKey !== undefined) {
    if (typeof body.apiKey !== "string") invalid("apiKey 必须是字符串");
    if (body.apiKey.length > REDEEM_REQUEST_LIMITS.apiKey) {
      invalid(`apiKey 超过 ${REDEEM_REQUEST_LIMITS.apiKey} 字符上限`);
    }
  }
  if (body.credentialMode !== undefined) {
    if (typeof body.credentialMode !== "string" || body.credentialMode.length > 32) {
      invalid("credentialMode 格式无效");
    }
    const mode = body.credentialMode.trim();
    if (mode && mode !== "session") invalid("credentialMode 不受支持");
  }
}

function validateArray(value, field) {
  if (!Array.isArray(value) || value.length === 0) invalid(`${field} 不能为空`);
  if (value.length > REDEEM_REQUEST_LIMITS.maxItems) {
    invalid(`${field} 超过 ${REDEEM_REQUEST_LIMITS.maxItems} 条上限`);
  }
}

function validateSubmitItems(items) {
  validateArray(items, "items");
  items.forEach((item, index) => {
    if (!isPlainObject(item)) invalid(`items[${index}] 必须是普通 JSON 对象`);
    validateString(
      item.channel ?? item.pool ?? item.queue,
      `items[${index}].channel`,
      REDEEM_REQUEST_LIMITS.channel
    );
    validateString(item.cdkey, `items[${index}].cdkey`, REDEEM_REQUEST_LIMITS.cdkey);
    validateString(
      item.access_token,
      `items[${index}].access_token`,
      REDEEM_REQUEST_LIMITS.accessToken
    );
  });
}

function validateCdkeys(cdkeys) {
  validateArray(cdkeys, "cdkeys");
  cdkeys.forEach((cdkey, index) => {
    validateString(cdkey, `cdkeys[${index}]`, REDEEM_REQUEST_LIMITS.cdkey);
  });
}

export function validateRedeemRequest(pathname, body) {
  validateCommon(body);
  if (pathname === "/api/redeem/submit") {
    validateSubmitItems(body.items);
  } else if ([
    "/api/redeem/status",
    "/api/redeem/cancel",
    "/api/redeem/retry"
  ].includes(pathname)) {
    validateCdkeys(body.cdkeys);
  } else {
    invalid("兑换接口不存在");
  }
  return body;
}
