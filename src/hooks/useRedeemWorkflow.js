import { useCallback, useMemo, useReducer, useRef } from "react";
import {
  applyWorkflowEvent,
  createInitialWorkflowState
} from "../workflow/redeemTaskModel.js";
import { WORKFLOW_EVENTS, createRowsEvent } from "../workflow/redeemEvents.js";

export function createRedeemWorkflowActions({ getState, dispatch, api, clock = Date.now }) {
  return {
    async submitRedeems(input) {
      dispatch({ type: WORKFLOW_EVENTS.SUBMIT_REQUESTED, input, createdAt: clock() });
    },
    async queryStatuses(cdkeys, options = {}) {
      dispatch({ type: WORKFLOW_EVENTS.STATUS_QUERY_REQUESTED, cdkeys, options, createdAt: clock() });
    },
    startPolling(cdkeys, options = {}) {
      dispatch({ type: WORKFLOW_EVENTS.POLLING_STARTED, cdkeys, options, createdAt: clock() });
    },
    stopPolling(options = {}) {
      dispatch({ type: WORKFLOW_EVENTS.POLLING_STOPPED, options, createdAt: clock() });
    },
    async retryRows(rows, options = {}) {
      dispatch({ type: WORKFLOW_EVENTS.RETRY_REQUESTED, rows, options, createdAt: clock() });
    },
    async cancelRows(rows, options = {}) {
      dispatch({ type: WORKFLOW_EVENTS.CANCEL_REQUESTED, rows, options, createdAt: clock() });
    },
    async checkPlus(rows, options = {}) {
      dispatch({ type: WORKFLOW_EVENTS.PLUS_CHECK_STARTED, rows, options, createdAt: clock() });
    }
  };
}

export function useRedeemWorkflow(initialState, dependencies = {}) {
  const [state, dispatchBase] = useReducer(
    (current, event) => applyWorkflowEvent(current, event),
    createInitialWorkflowState(initialState)
  );
  const stateRef = useRef(state);
  stateRef.current = state;
  const dispatch = useCallback((event) => {
    stateRef.current = applyWorkflowEvent(stateRef.current, event);
    dispatchBase(event);
  }, []);
  const getState = useCallback(() => stateRef.current, []);
  const updateRows = useCallback((nextRowsOrUpdater, type = WORKFLOW_EVENTS.ROWS_REPLACED, payload = {}) => {
    const currentRows = stateRef.current.rows;
    const nextRows = typeof nextRowsOrUpdater === "function"
      ? nextRowsOrUpdater(currentRows)
      : nextRowsOrUpdater;
    dispatch(createRowsEvent(type, nextRows, payload));
    return nextRows;
  }, [dispatch]);

  const actions = useMemo(
    () => createRedeemWorkflowActions({
      getState,
      dispatch,
      api: dependencies.api,
      clock: dependencies.clock || Date.now
    }),
    [dependencies.api, dependencies.clock, dispatch, getState]
  );

  return { state, dispatch, getState, updateRows, actions };
}
