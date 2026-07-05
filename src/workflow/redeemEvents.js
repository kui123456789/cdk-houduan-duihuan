export const WORKFLOW_EVENTS = Object.freeze({
  SUBMIT_REQUESTED: "SUBMIT_REQUESTED",
  SUBMIT_ACCEPTED: "SUBMIT_ACCEPTED",
  SUBMIT_FAILED: "SUBMIT_FAILED",
  STATUS_RECEIVED: "STATUS_RECEIVED",
  RETRY_REQUESTED: "RETRY_REQUESTED",
  CANCEL_REQUESTED: "CANCEL_REQUESTED",
  ACCOUNT_ATTEMPT_RECORDED: "ACCOUNT_ATTEMPT_RECORDED",
  ACCOUNT_COOLDOWN_STARTED: "ACCOUNT_COOLDOWN_STARTED",
  AUTO_CYCLE_REQUESTED: "AUTO_CYCLE_REQUESTED",
  AUTO_CYCLE_SUBMITTED: "AUTO_CYCLE_SUBMITTED",
  PLUS_CHECK_STARTED: "PLUS_CHECK_STARTED",
  PLUS_CHECK_RESULT: "PLUS_CHECK_RESULT",
  ACTIVITY_LOGGED: "ACTIVITY_LOGGED",
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
  missingAsUnused = false
} = {}) {
  return createWorkflowEvent(WORKFLOW_EVENTS.STATUS_RECEIVED, {
    cdkeys: normalizeArray(cdkeys),
    items: normalizeArray(items),
    missingAsUnused: missingAsUnused === true,
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
