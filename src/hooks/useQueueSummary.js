import { useCallback, useEffect, useRef, useState } from "react";
import { createRestartablePollingController } from "../domain/serializedPolling.js";

export const QUEUE_SUMMARY_REFRESH_MS = 5_000;

const EMPTY_QUEUE_SUMMARY = {
  vip: 0,
  normal: 0,
  ideal: 0,
  upi: 0,
  pix: 0,
  kakao: 0
};

function readCount(source, ...keys) {
  for (const key of keys) {
    const value = Number(source?.[key]);
    if (Number.isFinite(value)) return Math.max(Math.trunc(value), 0);
  }
  return 0;
}

export function normalizeQueueSummary(payload) {
  const source = payload?.data && typeof payload.data === "object" ? payload.data : payload;
  return {
    vip: readCount(source, "vip_queue_count", "vipQueueCount", "vip"),
    normal: readCount(source, "normal_queue_count", "normalQueueCount", "normal"),
    ideal: readCount(source, "ideal_queue_count", "idealQueueCount", "ideal"),
    upi: readCount(source, "upi_queue_count", "upiQueueCount", "upi"),
    pix: readCount(source, "pix_queue_count", "pixQueueCount", "pix"),
    kakao: readCount(source, "kakao_queue_count", "kakaoQueueCount", "kakao")
  };
}

export function useQueueSummary({ getRedeemApi, refreshIntervalMs = QUEUE_SUMMARY_REFRESH_MS } = {}) {
  const [summary, setSummary] = useState(EMPTY_QUEUE_SUMMARY);
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState("");
  const [checkedAt, setCheckedAt] = useState(0);
  const requestSeqRef = useRef(0);
  const getRedeemApiRef = useRef(getRedeemApi);
  const pollingControllerRef = useRef(null);
  getRedeemApiRef.current = getRedeemApi;

  const performRefresh = useCallback(async () => {
    const requestSeq = ++requestSeqRef.current;
    setStatus("loading");
    setError("");
    try {
      const api = getRedeemApiRef.current?.();
      if (!api?.getQueueSummary) throw new Error("队列概览接口不可用");
      const payload = await api.getQueueSummary();
      if (requestSeq !== requestSeqRef.current) return;
      setSummary(normalizeQueueSummary(payload));
      setCheckedAt(Date.now());
      setStatus("ready");
    } catch (requestError) {
      if (requestSeq !== requestSeqRef.current) return;
      setError(requestError?.message || "队列概览请求失败");
      setStatus("error");
    }
  }, []);

  if (!pollingControllerRef.current) {
    pollingControllerRef.current = createRestartablePollingController(performRefresh);
  }
  const refresh = pollingControllerRef.current.refresh;

  useEffect(() => {
    pollingControllerRef.current.start();
    const timer = window.setInterval(refresh, refreshIntervalMs);
    return () => {
      window.clearInterval(timer);
      requestSeqRef.current += 1;
      pollingControllerRef.current?.dispose();
    };
  }, [refresh, refreshIntervalMs]);

  return { summary, status, error, checkedAt, refresh };
}
