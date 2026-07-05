export function createSerializedPolling({
  intervalMs,
  query,
  setTimer = setTimeout,
  clearTimer = clearTimeout
}) {
  let timerId = null;
  let inFlight = false;
  let session = 0;
  let running = false;
  let sequence = 0;

  function stop() {
    running = false;
    session += 1;
    inFlight = false;
    if (timerId) {
      clearTimer(timerId);
      timerId = null;
    }
  }

  function start(cdkeys, options = {}) {
    stop();
    const cleanCdkeys = [...new Set((cdkeys || []).map((item) => String(item || "").trim()).filter(Boolean))];
    if (!cleanCdkeys.length) return { started: false, session };
    running = true;
    session += 1;
    const activeSession = session;

    const tick = async () => {
      if (!running || inFlight || activeSession !== session) return;
      inFlight = true;
      const pollingSeq = ++sequence;
      try {
        await query(cleanCdkeys, {
          ...options,
          pollingSession: activeSession,
          pollingSeq
        });
      } finally {
        inFlight = false;
        if (running && activeSession === session) {
          timerId = setTimer(tick, intervalMs);
        }
      }
    };

    timerId = setTimer(tick, intervalMs);
    return { started: true, session: activeSession };
  }

  return {
    start,
    stop,
    isRunning: () => running,
    getSession: () => session
  };
}
