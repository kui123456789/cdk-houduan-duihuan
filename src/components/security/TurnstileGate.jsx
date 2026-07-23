import { useEffect, useRef, useState } from "react";
import { Loader2, RotateCcw, ShieldAlert, ShieldCheck } from "lucide-react";

const TURNSTILE_SCRIPT_ID = "cloudflare-turnstile-script";
const TURNSTILE_SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

function loadTurnstileScript() {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  return new Promise((resolve, reject) => {
    const existing = document.getElementById(TURNSTILE_SCRIPT_ID);
    if (existing) {
      existing.addEventListener("load", () => resolve(window.turnstile), { once: true });
      existing.addEventListener("error", () => reject(new Error("Turnstile 加载失败")), { once: true });
      return;
    }

    const script = document.createElement("script");
    script.id = TURNSTILE_SCRIPT_ID;
    script.src = TURNSTILE_SCRIPT_URL;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve(window.turnstile);
    script.onerror = () => reject(new Error("Turnstile 加载失败"));
    document.head.appendChild(script);
  });
}

export function TurnstileGate({ onVerifiedChange }) {
  const hostRef = useRef(null);
  const widgetIdRef = useRef(null);
  const expiryTimerRef = useRef(null);
  const [state, setState] = useState(import.meta.env.DEV ? "verified" : "loading");
  const [retryVersion, setRetryVersion] = useState(0);

  useEffect(() => {
    if (import.meta.env.DEV) {
      onVerifiedChange(true);
      return undefined;
    }

    let cancelled = false;

    function clearWidget() {
      if (widgetIdRef.current != null && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current);
      }
      widgetIdRef.current = null;
    }

    function markVerified(expiresAt) {
      if (cancelled) return;
      clearWidget();
      setState("verified");
      onVerifiedChange(true);
      const expiresAtMs = Number(expiresAt || 0) * 1000;
      const delay = Math.max(1_000, expiresAtMs - Date.now() - 15_000);
      expiryTimerRef.current = window.setTimeout(() => {
        onVerifiedChange(false);
        setRetryVersion((value) => value + 1);
      }, delay);
    }

    async function renderChallenge() {
      const configResponse = await fetch("/api/security/config", { credentials: "same-origin" });
      const config = await configResponse.json().catch(() => ({}));
      if (!configResponse.ok || !config.siteKey) throw new Error("安全验证配置不可用");
      const turnstile = await loadTurnstileScript();
      if (cancelled || !hostRef.current) return;
      setState("challenge");
      widgetIdRef.current = turnstile.render(hostRef.current, {
        sitekey: config.siteKey,
        action: "cdk-redeem",
        theme: "dark",
        size: "normal",
        callback: async (token) => {
          try {
            const response = await fetch("/api/security/verify", {
              method: "POST",
              credentials: "same-origin",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ token })
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok || payload.verified !== true) {
              throw new Error(payload.error || "安全验证失败");
            }
            markVerified(payload.expiresAt);
          } catch {
            if (cancelled) return;
            onVerifiedChange(false);
            setState("error");
          }
        },
        "expired-callback": () => {
          onVerifiedChange(false);
          if (!cancelled) turnstile.reset(widgetIdRef.current);
        },
        "error-callback": () => {
          onVerifiedChange(false);
          if (!cancelled) setState("error");
        }
      });
    }

    async function initialize() {
      setState("loading");
      onVerifiedChange(false);
      try {
        const response = await fetch("/api/security/status", { credentials: "same-origin" });
        const payload = await response.json().catch(() => ({}));
        if (response.ok && payload.verified === true) {
          markVerified(payload.expiresAt);
          return;
        }
        await renderChallenge();
      } catch {
        if (!cancelled) setState("error");
      }
    }

    initialize();
    return () => {
      cancelled = true;
      clearWidget();
      if (expiryTimerRef.current) window.clearTimeout(expiryTimerRef.current);
    };
  }, [onVerifiedChange, retryVersion]);

  if (import.meta.env.DEV) return null;

  return (
    <div className={`security-gate ${state}`} aria-live="polite">
      {state === "loading" ? (
        <><Loader2 size={17} className="spin" /><span>安全检查中</span></>
      ) : null}
      {state === "verified" ? (
        <><ShieldCheck size={18} /><span>安全验证通过</span></>
      ) : null}
      {state === "error" ? (
        <>
          <ShieldAlert size={18} />
          <span>安全验证暂不可用</span>
          <button type="button" className="icon-button" onClick={() => setRetryVersion((value) => value + 1)} aria-label="重新验证" title="重新验证">
            <RotateCcw size={15} />
          </button>
        </>
      ) : null}
      <div ref={hostRef} className={state === "challenge" ? "turnstile-host active" : "turnstile-host"} />
    </div>
  );
}
