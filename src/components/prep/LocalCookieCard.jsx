import { useEffect, useState } from "react";
import { Check, KeyRound, Loader2, Play, Trash2 } from "lucide-react";

export function LocalCookieCard({ api }) {
  const [open, setOpen] = useState(false);
  const [cookie, setCookie] = useState("");
  const [sessionToken, setSessionToken] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [configured, setConfigured] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    api.getStatus().then((result) => {
      if (!cancelled) setConfigured(result.configured === true);
    }).catch((error) => {
      if (!cancelled) setMessage(error?.message || "无法连接本地 Cookie 后台");
    });
    return () => { cancelled = true; };
  }, [api]);

  function closeDialog() {
    setCookie("");
    setSessionToken("");
    setDeviceId("");
    setOpen(false);
  }

  async function handleStart() {
    if (!cookie.trim() && !sessionToken.trim()) {
      setMessage("请填写 Session Token 或 Cookie");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      await api.setCredential({
        cookie: cookie.trim(),
        sessionToken: sessionToken.trim(),
        deviceId: deviceId.trim()
      });
      setConfigured(true);
      setCookie("");
      setSessionToken("");
      setDeviceId("");
      setOpen(false);
      setMessage("后台登录凭证已验证并启动，仅保存在本机内存");
    } catch (error) {
      setCookie("");
      setSessionToken("");
      setDeviceId("");
      setMessage(error.message || "启动后台 Cookie 失败");
    } finally {
      setBusy(false);
    }
  }

  async function handleClear() {
    setCookie("");
    setSessionToken("");
    setDeviceId("");
    setBusy(true);
    try {
      await api.clearCookie();
      setConfigured(false);
      setMessage("后台 Cookie 已清除");
    } catch (error) {
      setMessage(error.message || "清除失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="local-cookie-card" aria-label="本地后台登录凭证">
      <div className="local-cookie-heading">
        <span className="panel-icon"><KeyRound size={16} /></span>
        <div>
          <h2>本地后台登录凭证</h2>
          <p>用于查询后台队列；凭证不写入浏览器或磁盘。</p>
        </div>
      </div>
      <div className="local-cookie-actions">
        <span className={configured ? "local-cookie-status ready" : "local-cookie-status"}>
          {configured ? <Check size={14} /> : null}
          {configured ? "已配置" : "未配置"}
        </span>
        <button type="button" className="secondary-button" onClick={() => { setCookie(""); setSessionToken(""); setDeviceId(""); setMessage(""); setOpen(true); }} disabled={busy}>
          {busy ? <Loader2 size={15} className="spin" /> : <Play size={15} />}
          设置登录凭证
        </button>
        <button type="button" className="ghost-button" onClick={handleClear} disabled={busy || !configured} title="清除本机内存中的 Cookie">
          <Trash2 size={15} />
          清除
        </button>
      </div>
      {open ? (
        <div className="local-cookie-dialog" role="dialog" aria-modal="true" aria-label="设置本地后台登录凭证">
          <label className="field-stack">
            <span>Session Token</span>
            <input type="password" value={sessionToken} onChange={(event) => setSessionToken(event.target.value)} placeholder="X-Session-Token" spellCheck="false" autoComplete="off" autoFocus />
          </label>
          <label className="field-stack">
            <span>Cookie（可选）</span>
            <input type="password" value={cookie} onChange={(event) => setCookie(event.target.value)} placeholder="Cookie: name=value; ..." spellCheck="false" autoComplete="off" />
          </label>
          <label className="field-stack">
            <span>Device ID</span>
            <input type="password" value={deviceId} onChange={(event) => setDeviceId(event.target.value)} placeholder="X-Device-Id（可选）" spellCheck="false" autoComplete="off" />
          </label>
          <div className="local-cookie-dialog-actions">
            <button type="button" className="ghost-button" onClick={closeDialog} disabled={busy}>取消</button>
            <button type="button" className="primary-button" onClick={handleStart} disabled={busy}>
              {busy ? <Loader2 size={15} className="spin" /> : <Play size={15} />}
              启动
            </button>
          </div>
        </div>
      ) : null}
      {message ? <div className="input-validity">{message}</div> : null}
    </section>
  );
}
