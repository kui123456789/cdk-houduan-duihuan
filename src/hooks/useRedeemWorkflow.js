import { useMemo, useReducer } from "react";
import {
  applyWorkflowEvent,
  createInitialWorkflowState
} from "../workflow/redeemTaskModel.js";

export function createRedeemWorkflowActions({ dispatch, clock = Date.now }) {
  return {
    async submitRedeems(input) {
      dispatch({ type: "ui_submit_requested", input, createdAt: clock() });
    },
    async queryStatuses(cdkeys, options = {}) {
      dispatch({ type: "ui_status_query_requested", cdkeys, options, createdAt: clock() });
    },
    startPolling(cdkeys, options = {}) {
      dispatch({ type: "ui_polling_started", cdkeys, options, createdAt: clock() });
    },
    stopPolling(options = {}) {
      dispatch({ type: "ui_polling_stopped", options, createdAt: clock() });
    },
    async retryRows(rows, options = {}) {
      dispatch({ type: "ui_retry_requested", rows, options, createdAt: clock() });
    },
    async cancelRows(rows, options = {}) {
      dispatch({ type: "ui_cancel_requested", rows, options, createdAt: clock() });
    },
    async checkPlus(rows, options = {}) {
      dispatch({ type: "ui_plus_check_requested", rows, options, createdAt: clock() });
    }
  };
}

export function useRedeemWorkflow(initialState, dependencies = {}) {
  const [state, dispatchBase] = useReducer(
    (current, event) => applyWorkflowEvent(current, event),
    createInitialWorkflowState(initialState)
  );
  const actions = useMemo(
    () => createRedeemWorkflowActions({
      dispatch: dispatchBase,
      clock: dependencies.clock || Date.now
    }),
    [dependencies.clock]
  );

  return { state, dispatch: dispatchBase, actions };
}
