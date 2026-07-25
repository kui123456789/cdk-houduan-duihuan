import { useCallback, useEffect, useRef, useState } from "react";
import { JOB_IDS_STORAGE_KEY, isTerminalJob } from "../services/jobApi.js";

export function hasActiveJobs(jobs) {
  return (jobs || []).some((job) => !isTerminalJob(job));
}

export function shouldRefreshForStorageEvent(event) {
  return event?.key === JOB_IDS_STORAGE_KEY || event?.key === null;
}

export function useJobs({ enabled, jobApi, onJobsChanged = () => {}, pollMs = 5_000 }) {
  const [jobs, setJobs] = useState([]);
  const jobsRef = useRef(jobs);

  const refreshJobs = useCallback(async () => {
    if (!enabled) return [];
    const next = await jobApi.listJobs();
    jobsRef.current = next;
    setJobs(next);
    onJobsChanged(next);
    return next;
  }, [enabled, jobApi, onJobsChanged]);

  useEffect(() => {
    if (!enabled) return undefined;
    void refreshJobs();
    const onStorage = (event) => {
      if (shouldRefreshForStorageEvent(event)) void refreshJobs();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [enabled, refreshJobs]);

  useEffect(() => {
    if (!enabled || !hasActiveJobs(jobs)) return undefined;
    const timer = window.setInterval(() => void refreshJobs(), pollMs);
    return () => window.clearInterval(timer);
  }, [enabled, jobs, pollMs, refreshJobs]);

  return { jobs, refreshJobs, hasActiveJobs: hasActiveJobs(jobs) };
}
