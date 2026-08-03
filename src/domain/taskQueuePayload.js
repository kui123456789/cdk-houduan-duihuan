function nullableNonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(Math.trunc(number), 0) : null;
}

export function sanitizeTaskQueueItem(task = {}) {
  return {
    cdkey: String(task?.cdkey || task?.cdKey || task?.cd_key || "").trim(),
    status: String(task?.status || "").trim(),
    display_status: String(task?.display_status || task?.displayStatus || "").trim(),
    updated_at: String(task?.updated_at || task?.updatedAt || "").trim(),
    queue_ahead_count: nullableNonNegativeInteger(
      task?.queue_ahead_count ?? task?.queueAheadCount
    ),
    queue_position: nullableNonNegativeInteger(
      task?.queue_position ?? task?.queuePosition
    ),
    is_vip: task?.is_vip === true || task?.isVip === true,
    payment_method: String(task?.payment_method || task?.paymentMethod || "").trim()
  };
}

export function sanitizeTaskQueuePayload(payload = {}) {
  const data = payload?.data && typeof payload.data === "object" ? payload.data : {};
  const list = Array.isArray(data.list) ? data.list : Array.isArray(data.items) ? data.items : [];
  return {
    ok: true,
    code: payload?.code,
    message: payload?.message,
    data: {
      list: list.map(sanitizeTaskQueueItem),
      pagination: data.pagination && typeof data.pagination === "object" ? data.pagination : {}
    }
  };
}
