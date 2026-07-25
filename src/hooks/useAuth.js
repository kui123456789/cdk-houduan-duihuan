import { useCallback, useEffect, useState } from "react";

export function useAuth({ enabled, authApi }) {
  const [state, setState] = useState(() => ({
    status: enabled ? "loading" : "disabled",
    user: null,
    error: ""
  }));

  useEffect(() => {
    let active = true;
    if (!enabled) {
      setState({ status: "disabled", user: null, error: "" });
      return () => { active = false; };
    }
    setState((current) => ({ ...current, status: "loading", error: "" }));
    authApi.restore().then(
      (payload) => {
        if (active) setState({ status: "authenticated", user: payload.user, error: "" });
      },
      (error) => {
        if (!active) return;
        setState({
          status: error?.status === 401 ? "anonymous" : "error",
          user: null,
          error: error?.status === 401 ? "" : error.message
        });
      }
    );
    return () => { active = false; };
  }, [authApi, enabled]);

  const login = useCallback(async (username, password) => {
    setState({ status: "loading", user: null, error: "" });
    try {
      const payload = await authApi.login(username, password);
      setState({ status: "authenticated", user: payload.user, error: "" });
      return payload.user;
    } catch (error) {
      setState({ status: "anonymous", user: null, error: error.message });
      throw error;
    }
  }, [authApi]);

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
      setState({ status: "anonymous", user: null, error: "" });
    } catch (error) {
      setState((current) => ({ ...current, error: error.message }));
    }
  }, [authApi]);

  return { ...state, login, logout };
}
