export function createAuthApi({ fetchImpl = fetch } = {}) {
  let csrfToken = "";

  async function request(path, options = {}) {
    const response = await fetchImpl(path, {
      credentials: "same-origin",
      headers: { Accept: "application/json", ...(options.headers || {}) },
      ...options
    });
    const payload = response.status === 204 ? {} : await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.message || `请求失败：${response.status}`);
      error.code = payload.code || "AUTH_REQUEST_FAILED";
      error.status = response.status;
      throw error;
    }
    if (payload.csrfToken) csrfToken = payload.csrfToken;
    return payload;
  }

  return {
    getCsrfToken: () => csrfToken,
    async restore() {
      return request("/api/auth/me");
    },
    async login(username, password) {
      return request("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password })
      });
    },
    async logout() {
      await request("/api/auth/logout", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: "{}"
      });
      csrfToken = "";
    }
  };
}
