import { createHash, randomUUID } from "node:crypto";

const SENSITIVE_KEY = /(?:authorization|cookie|password|passkey|secret|token|api.?key|credential|2fa)/i;
const DIGEST_KEY = /(?:email|account)/i;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

function digest(value) {
  return createHash("sha256").update(String(value || "")).digest("hex").slice(0, 12);
}

function sanitizeText(value) {
  return String(value || "")
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, (match) => `[email:${digest(match.toLowerCase())}]`)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_JWT]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_KEY]")
    .slice(0, 1000);
}

export function redactLogValue(value, key = "", depth = 0) {
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (value === null || value === undefined) return value;
  if (DIGEST_KEY.test(key) && ["string", "number"].includes(typeof value)) {
    return `sha256:${digest(value)}`;
  }
  if (typeof value === "string") return sanitizeText(value);
  if (["number", "boolean"].includes(typeof value)) return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: sanitizeText(value.name),
      code: sanitizeText(value.code || "INTERNAL_ERROR")
    };
  }
  if (depth >= 5) return "[TRUNCATED]";
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => redactLogValue(item, key, depth + 1));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        redactLogValue(childValue, childKey, depth + 1)
      ])
    );
  }
  return sanitizeText(value);
}

export function createLogger({ write = (line) => console.log(line), base = {} } = {}) {
  function emit(level, eventType, fields = {}) {
    const entry = redactLogValue({
      timestamp: new Date().toISOString(),
      level,
      eventType: String(eventType || "event"),
      ...base,
      ...fields
    });
    write(JSON.stringify(entry));
    return entry;
  }

  return {
    debug: (eventType, fields) => emit("debug", eventType, fields),
    info: (eventType, fields) => emit("info", eventType, fields),
    warn: (eventType, fields) => emit("warn", eventType, fields),
    error: (eventType, fields) => emit("error", eventType, fields),
    child(fields = {}) {
      return createLogger({ write, base: { ...base, ...fields } });
    }
  };
}

function requestIdFrom(req) {
  const candidate = String(req.get("X-Request-Id") || "").trim();
  return REQUEST_ID_PATTERN.test(candidate) ? candidate : randomUUID();
}

function requestRoute(req) {
  const pathname = String(req.originalUrl || req.url || "").split("?")[0];
  return pathname
    .replace(/(\/api\/jobs\/)[^/]+/, "$1:jobId")
    .replace(/\/$/, "") || "/";
}

function requestJobId(req) {
  const pathname = String(req.originalUrl || req.url || "").split("?")[0];
  const match = /^\/api\/jobs\/([^/]+)/.exec(pathname);
  return match ? decodeURIComponent(match[1]).slice(0, 128) : undefined;
}

export function createRequestContextMiddleware({ logger, metrics } = {}) {
  return (req, res, next) => {
    const requestId = requestIdFrom(req);
    const startedAt = process.hrtime.bigint();
    let completed = false;
    req.requestId = requestId;
    req.log = logger?.child({ requestId });
    res.set("X-Request-Id", requestId);

    const record = (eventType, aborted = false) => {
      if (completed) return;
      completed = true;
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      const fields = {
        requestId,
        method: req.method,
        route: requestRoute(req),
        statusCode: res.statusCode,
        durationMs: Number(durationMs.toFixed(3)),
        jobId: requestJobId(req),
        aborted
      };
      metrics?.recordHttp(fields);
      req.log?.info(eventType, fields);
    };

    res.once("finish", () => record("http_request_completed"));
    res.once("close", () => {
      if (!res.writableEnded) record("http_request_aborted", true);
    });
    next();
  };
}
