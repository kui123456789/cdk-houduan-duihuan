export const WORKFLOW_EVENTS = Object.freeze({
  SUBMIT_REQUESTED: "SUBMIT_REQUESTED",
  SUBMIT_ACCEPTED: "SUBMIT_ACCEPTED",
  SUBMIT_FAILED: "SUBMIT_FAILED",
  STATUS_QUERY_REQUESTED: "STATUS_QUERY_REQUESTED",
  STATUS_RECEIVED: "STATUS_RECEIVED",
  POLLING_STARTED: "POLLING_STARTED",
  POLLING_STOPPED: "POLLING_STOPPED",
  RETRY_REQUESTED: "RETRY_REQUESTED",
  CANCEL_REQUESTED: "CANCEL_REQUESTED",
  ACCOUNT_ATTEMPT_RECORDED: "ACCOUNT_ATTEMPT_RECORDED",
  ACCOUNT_COOLDOWN_STARTED: "ACCOUNT_COOLDOWN_STARTED",
  AUTO_CYCLE_REQUESTED: "AUTO_CYCLE_REQUESTED",
  AUTO_CYCLE_SUBMITTED: "AUTO_CYCLE_SUBMITTED",
  PLUS_CHECK_STARTED: "PLUS_CHECK_STARTED",
  PLUS_CHECK_RESULT: "PLUS_CHECK_RESULT",
  ACTIVITY_LOGGED: "ACTIVITY_LOGGED",
  ROWS_REPLACED: "ROWS_REPLACED",
  ROWS_CLEARED: "ROWS_CLEARED"
});

const WORKFLOW_EVENT_TYPES = new Set(Object.values(WORKFLOW_EVENTS));

function createEventId() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  return `event-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

export function normalizeEmail(value) {
  return String(value ?? "").trim().toLowerCase();
}

export function createWorkflowEvent(type, payload = {}) {
  if (!WORKFLOW_EVENT_TYPES.has(type)) {
    throw new TypeError(`Unknown workflow event type: ${type}`);
  }

  return {
    ...payload,
    id: createEventId(),
    type,
    createdAt: Date.now()
  };
}

export function createSubmitAcceptedEvent({ rowIds = [], items = [], message = "" } = {}) {
  return createWorkflowEvent(WORKFLOW_EVENTS.SUBMIT_ACCEPTED, {
    rowIds: normalizeArray(rowIds),
    items: normalizeArray(items),
    message
  });
}

export function createStatusReceivedEvent({
  cdkeys = [],
  items = [],
  raw = null,
  missingAsSyncPending = false,
  pollingGeneration,
  rows
} = {}) {
  return createWorkflowEvent(WORKFLOW_EVENTS.STATUS_RECEIVED, {
    cdkeys: normalizeArray(cdkeys),
    items: normalizeArray(items),
    missingAsSyncPending: missingAsSyncPending === true,
    ...(Number.isSafeInteger(pollingGeneration) ? { pollingGeneration } : {}),
    ...(Array.isArray(rows) ? { rows } : {}),
    raw
  });
}

export function createAccountCooldownEvent({ email, until, reason } = {}) {
  return createWorkflowEvent(WORKFLOW_EVENTS.ACCOUNT_COOLDOWN_STARTED, {
    email: normalizeEmail(email),
    until,
    reason
  });
}

export function createRowsEvent(type, rows, payload = {}) {
  return createWorkflowEvent(type, {
    ...payload,
    rows: normalizeArray(rows)
  });
}

export function createPollingStartedEvent({ generation, cdkeys = [], options = {} } = {}) {
  return createWorkflowEvent(WORKFLOW_EVENTS.POLLING_STARTED, {
    generation: Number.isSafeInteger(generation) ? generation : undefined,
    cdkeys: normalizeArray(cdkeys),
    options
  });
}
