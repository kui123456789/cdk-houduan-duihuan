const DEFAULT_MAX_ENTRIES = 100;
const VALID_LEVELS = new Set(["info", "success", "warning", "error"]);
const VALID_ACTIONS = new Set([
  "submit",
  "query",
  "cancel",
  "cooldown",
  "auto_cycle",
  "plus_check",
  "status",
  "validation"
]);

function getNow(options = {}) {
  const value = Number(options.now);
  return Number.isFinite(value) ? value : Date.now();
}

function getMaxEntries(options = {}) {
  const value = Number(options.maxEntries);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_MAX_ENTRIES;
}

function normalizeString(value) {
  return String(value || "").trim();
}

function createLogId(options = {}) {
  const now = getNow(options);
  const random = typeof options.random === "function" ? options.random() : Math.random();
  const suffix = Math.floor(Math.abs(Number(random) || 0) * 1_000_000)
    .toString(36)
    .padStart(4, "0");
  return `log-${now.toString(36)}-${suffix}`;
}

export function maskActivityLogCdkey(cdkey) {
  const value = normalizeString(cdkey);
  if (!value) return "";
  const compact = value.replace(/\s+/g, "");
  if (compact.length <= 8) return compact;
  return `${compact.slice(0, 4)}...${compact.slice(-4)}`;
}

function normalizeActivityLogEntry(entry, options = {}) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;

  const message = normalizeString(entry.message);
  if (!message) return null;

  const createdAt = Number(entry.createdAt);
  const level = normalizeString(entry.level) || "info";
  const action = normalizeString(entry.action) || "status";

  if (!VALID_LEVELS.has(level) || !VALID_ACTIONS.has(action)) return null;

  return {
    id: normalizeString(entry.id) || createLogId(options),
    createdAt: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : getNow(options),
    level,
    action,
    email: normalizeString(entry.email),
    cdkey: normalizeString(entry.cdkey),
    message
  };
}

export function compactActivityLog(log, options = {}) {
  const maxEntries = getMaxEntries(options);
  if (!Array.isArray(log)) return [];
  return log
    .map((entry) => normalizeActivityLogEntry(entry, options))
    .filter(Boolean)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, maxEntries);
}

export function appendActivityLog(log, entry, options = {}) {
  const normalizedEntry = normalizeActivityLogEntry(
    {
      ...entry,
      id: entry?.id || createLogId(options),
      createdAt: entry?.createdAt || getNow(options)
    },
    options
  );

  if (!normalizedEntry) return compactActivityLog(log, options);

  return compactActivityLog([normalizedEntry, ...(Array.isArray(log) ? log : [])], options);
}

export function formatActivityLogMessage(entry) {
  const normalized = normalizeActivityLogEntry(entry);
  if (!normalized) return "";

  const parts = [];
  if (normalized.email) parts.push(normalized.email);
  if (normalized.cdkey) parts.push(maskActivityLogCdkey(normalized.cdkey));
  parts.push(normalized.message);
  return parts.join(" · ");
}
