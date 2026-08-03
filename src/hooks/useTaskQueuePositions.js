import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRestartablePollingController } from "../domain/serializedPolling.js";

export const TASK_QUEUE_REFRESH_MS = 5_000;
const MAX_TASK_QUEUE_PAGES = 100;
const FULL_TASK_QUEUE_SCAN_INTERVAL_MS = 30_000;

export function normalizeTaskQueueCdkey(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, "")
    .toLowerCase();
}

export function createTaskQueueTargetKey(cdkeys = []) {
  return [...new Set(cdkeys.map(normalizeTaskQueueCdkey).filter(Boolean))]
    .sort()
    .join("\n");
}

function readNumber(source, keys) {
  for (const key of keys) {
    const value = Number(source?.[key]);
    if (Number.isFinite(value) && value > 0) return Math.trunc(value);
  }
  return 0;
}

function readNonNegativeNumber(source, keys) {
  for (const key of keys) {
    const value = Number(source?.[key]);
    if (Number.isFinite(value) && value >= 0) return Math.trunc(value);
  }
  return null;
}

function getTaskList(payload) {
  const source = payload?.data && typeof payload.data === "object" ? payload.data : payload;
  if (Array.isArray(source?.list)) return source.list;
  if (Array.isArray(source?.items)) return source.items;
  if (Array.isArray(payload)) return payload;
  return [];
}

function getPagination(payload) {
  const source = payload?.data && typeof payload.data === "object" ? payload.data : payload;
  return source?.pagination && typeof source.pagination === "object" ? source.pagination : {};
}

function getTaskCdkey(task) {
  return normalizeTaskQueueCdkey(
    task?.cdkey ||
      task?.cdKey ||
      task?.cd_key ||
      task?.cdk ||
      task?.cdkCode ||
      task?.cdk_code ||
      task?.redeemCode ||
      task?.redeem_code ||
      task?.code ||
      task?.key
  );
}

export function normalizeTaskQueuePositions(payloads, targetCdkeys = []) {
  const targetByKey = new Map(
    targetCdkeys
    .map((target) => [normalizeTaskQueueCdkey(target), String(target || "").trim()])
      .filter(([key, original]) => key && original)
  );
  const targets = new Set(targetByKey.keys());
  const positions = {};

  for (const payload of payloads || []) {
    const pagination = getPagination(payload);
    const page = Math.max(Number(pagination.page) || 1, 1);
    const pageSize = Math.max(Number(pagination.page_size || pagination.pageSize) || 100, 1);
    const list = getTaskList(payload);
    list.forEach((task, index) => {
      const taskCdkey = getTaskCdkey(task);
      const cdkey = normalizeTaskQueueCdkey(taskCdkey);
      const outputKey = targetByKey.get(cdkey) || taskCdkey;
      if (!cdkey || (targets.size && !targets.has(cdkey)) || positions[outputKey]) return;
      const queueAhead = readNonNegativeNumber(task, [
        "queue_ahead_count",
        "queueAheadCount",
        "queue_ahead",
        "queueAhead",
        "ahead_count",
        "aheadCount",
        "tasks_ahead",
        "tasksAhead"
      ]);
      if (queueAhead !== null) {
        positions[outputKey] = queueAhead + 1;
        return;
      }
      const explicitPosition = readNumber(task, [
        "queue_position",
        "queuePosition",
        "position",
        "rank",
        "index"
      ]);
      positions[outputKey] = explicitPosition || (page - 1) * pageSize + index + 1;
    });
  }

  return positions;
}

export function getTaskQueuePageCount(payload, pageSize = 100) {
  const pagination = getPagination(payload);
  const total = Number(pagination.total);
  const responsePageSize = Number(pagination.page_size || pagination.pageSize);
  const effectivePageSize = Number.isFinite(responsePageSize) && responsePageSize > 0
    ? responsePageSize
    : pageSize;
  if (!Number.isFinite(total) || total <= effectivePageSize) return 1;
  return Math.min(Math.ceil(total / effectivePageSize), MAX_TASK_QUEUE_PAGES);
}

export function useTaskQueuePositions({
  getRedeemApi,
  cdkeys = [],
  refreshIntervalMs = TASK_QUEUE_REFRESH_MS
} = {}) {
  const [positions, setPositions] = useState({});
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");
  const [checkedAt, setCheckedAt] = useState(0);
  const [stats, setStats] = useState({ matched: 0, target: 0, pagesFetched: 0, totalPages: 0, backendTotal: 0 });
  const getRedeemApiRef = useRef(getRedeemApi);
  const requestSeqRef = useRef(0);
  const targetKeyRef = useRef("");
  const pollingControllerRef = useRef(null);
  const matchedPageByTargetRef = useRef(new Map());
  const lastFullScanAtRef = useRef(0);
  const lastTargetKeyRef = useRef("");
  getRedeemApiRef.current = getRedeemApi;
  const targetKey = useMemo(() => createTaskQueueTargetKey(cdkeys), [cdkeys]);
  targetKeyRef.current = targetKey;

  const performRefresh = useCallback(async () => {
    const targetKey = targetKeyRef.current;
    const targets = targetKey ? targetKey.split("\n") : [];
    if (!targets.length) {
      setPositions({});
      setStatus("idle");
      setError("");
      setStats({ matched: 0, target: 0, pagesFetched: 0, totalPages: 0, backendTotal: 0 });
      return;
    }

    const requestSeq = ++requestSeqRef.current;
    setStatus("loading");
    setError("");
    try {
      const api = getRedeemApiRef.current?.();
      if (!api?.getRedeemTasks) throw new Error("后台任务列表接口不可用");
      const pageSize = 100;
      const firstPage = await api.getRedeemTasks({ page: 1, pageSize });
      const payloads = [firstPage];
      const fetchedPages = new Set([1]);
      const totalPages = getTaskQueuePageCount(firstPage, pageSize);
      const firstPagination = getPagination(firstPage);
      const backendTotal = Number.isFinite(Number(firstPagination.total))
        ? Math.max(Number(firstPagination.total), 0)
        : 0;
      const targetChanged = lastTargetKeyRef.current !== targetKey;
      if (targetChanged) matchedPageByTargetRef.current.clear();
      const cachedPages = [...new Set(
        targets
          .map((target) => matchedPageByTargetRef.current.get(target))
          .filter((page) => page > 1 && page <= totalPages)
      )];
      for (const page of cachedPages) {
        payloads.push(await api.getRedeemTasks({ page, pageSize }));
        fetchedPages.add(page);
      }

      const shouldFullScan =
        targetChanged || Date.now() - lastFullScanAtRef.current >= FULL_TASK_QUEUE_SCAN_INTERVAL_MS;
      if (shouldFullScan) for (let page = 2; page <= totalPages; page += 1) {
        const currentPositions = normalizeTaskQueuePositions(payloads, targets);
        if (targets.every((target) => currentPositions[target])) break;
        if (fetchedPages.has(page)) continue;
        payloads.push(await api.getRedeemTasks({ page, pageSize }));
      }
      if (shouldFullScan) lastFullScanAtRef.current = Date.now();
      if (requestSeq !== requestSeqRef.current) return;
      const nextPositions = normalizeTaskQueuePositions(payloads, targets);
      for (const payload of payloads) {
        const page = Math.max(Number(getPagination(payload).page) || 1, 1);
        for (const task of getTaskList(payload)) {
          const taskCdkey = getTaskCdkey(task);
          if (targets.includes(taskCdkey)) matchedPageByTargetRef.current.set(taskCdkey, page);
        }
      }
      if (shouldFullScan) {
        targets.forEach((target) => {
          if (!nextPositions[target]) matchedPageByTargetRef.current.delete(target);
        });
      }
      lastTargetKeyRef.current = targetKey;
      setPositions(nextPositions);
      setStats({
        matched: Object.keys(nextPositions).length,
        target: targets.length,
        pagesFetched: payloads.length,
        totalPages,
        backendTotal
      });
      setCheckedAt(Date.now());
      setStatus("ready");
    } catch (requestError) {
      if (requestSeq !== requestSeqRef.current) return;
      setError(requestError?.message || "后台任务列表请求失败");
      setStatus("error");
    } finally {
      // The serialized runner releases the in-flight slot and coalesces a queued refresh.
    }
  }, []);

  if (!pollingControllerRef.current) {
    pollingControllerRef.current = createRestartablePollingController(performRefresh);
  }
  const refresh = pollingControllerRef.current.refresh;

  useEffect(() => {
    requestSeqRef.current += 1;
    pollingControllerRef.current.start();
    const timer = window.setInterval(refresh, refreshIntervalMs);
    return () => {
      window.clearInterval(timer);
      requestSeqRef.current += 1;
      pollingControllerRef.current?.dispose();
    };
  }, [refresh, refreshIntervalMs, targetKey]);

  return { positions, status, error, checkedAt, stats, refresh };
}
