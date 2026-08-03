import { useEffect, useRef } from "react";

export function claimInitialStatusSync(startedRef) {
  if (startedRef?.current === true) return false;
  if (startedRef) startedRef.current = true;
  return true;
}

export function useInitialRedeemLifecycle(options) {
  const startedRef = useRef(false);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    const current = optionsRef.current;
    if (claimInitialStatusSync(startedRef)) {
      const storedRows = current.getCurrentTaskRows(current.rowsRef.current);
      const storedCdkeys = current.getRowCdkeys(storedRows);
      if (storedRows.length > 0 && storedCdkeys.length > 0) {
        current.queryStatuses(storedCdkeys, {
          silent: true,
          forceRemote: true,
          skipAutoCycle: current.autoCycleRef.current.enabled !== true,
          baseRows: current.rowsRef.current
        });
      }
    }

    return () => {
      const latest = optionsRef.current;
      latest.stopPolling({ persist: false });
      latest.clearAutoCycleScheduleTimer();
      latest.clearToastTimer();
    };
  }, []);
}
