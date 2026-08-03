export function createSerializedPollingRunner(run) {
  let inFlight = null;
  let rerunRequested = false;
  let disposed = false;

  async function refresh() {
    if (disposed) return;
    if (inFlight) {
      rerunRequested = true;
      return inFlight;
    }

    inFlight = (async () => {
      do {
        rerunRequested = false;
        await run();
      } while (rerunRequested && !disposed);
    })();

    try {
      await inFlight;
    } finally {
      inFlight = null;
    }
  }

  return {
    refresh,
    dispose() {
      disposed = true;
      rerunRequested = false;
    }
  };
}

export function createRestartablePollingController(run) {
  let runner = null;

  return {
    start() {
      runner?.dispose();
      runner = createSerializedPollingRunner(run);
      return runner.refresh();
    },
    refresh() {
      return runner?.refresh();
    },
    dispose() {
      runner?.dispose();
      runner = null;
    }
  };
}
