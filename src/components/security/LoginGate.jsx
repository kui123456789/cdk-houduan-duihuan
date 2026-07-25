import { LockKeyhole, LogIn, Loader2, Shield } from "lucide-react";
import { useState } from "react";

export function LoginGate({ status, error, onLogin }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const loading = status === "loading";

  async function submit(event) {
    event.preventDefault();
    try {
      await onLogin(username, password);
    } catch {
      // The parent owns the public error state.
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-panel" aria-labelledby="auth-title">
        <div className="auth-brand" aria-hidden="true"><Shield size={22} /></div>
        <div className="auth-heading">
          <h1 id="auth-title">CDK 后端兑换控制台</h1>
          <p>登录后进入任务工作区</p>
        </div>
        {loading && !error ? (
          <div className="auth-loading" role="status">
            <Loader2 size={18} className="spin" /> 正在验证会话
          </div>
        ) : (
          <form className="auth-form" onSubmit={submit}>
            <label htmlFor="auth-username">用户名</label>
            <div className="auth-input-wrap">
              <LogIn size={17} aria-hidden="true" />
              <input
                id="auth-username"
                name="username"
                autoComplete="username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                required
                autoFocus
              />
            </div>
            <label htmlFor="auth-password">密码</label>
            <div className="auth-input-wrap">
              <LockKeyhole size={17} aria-hidden="true" />
              <input
                id="auth-password"
                name="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </div>
            {error ? <p className="auth-error" role="alert">{error}</p> : null}
            <button type="submit" className="primary-button auth-submit" disabled={loading}>
              {loading ? <Loader2 size={17} className="spin" /> : <LogIn size={17} />}
              登录
            </button>
          </form>
        )}
      </section>
    </main>
  );
}
