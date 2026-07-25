import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual
} from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const SESSION_COOKIE = "cdk_session";

function sha256(value) {
  return createHash("sha256").update(String(value || "")).digest("hex");
}

function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}

function publicUser(row) {
  return row ? { id: row.id, username: row.username, role: row.role } : null;
}

function parseCookies(header) {
  return Object.fromEntries(
    String(header || "")
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        return index < 0
          ? [part, ""]
          : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      })
  );
}

async function passwordDigest(password, salt) {
  return Buffer.from(await scrypt(String(password || ""), salt, 64));
}

function constantTimeHexEqual(left, right) {
  try {
    const leftBytes = Buffer.from(String(left || ""), "hex");
    const rightBytes = Buffer.from(String(right || ""), "hex");
    return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
  } catch {
    return false;
  }
}

export function createSessionService({
  database,
  cookieName = SESSION_COOKIE,
  sessionTtlMs = 8 * 60 * 60 * 1000,
  secureCookies = process.env.NODE_ENV === "production"
} = {}) {
  if (!database?.query) throw new TypeError("database is required");

  async function createUser({ username, password, role = "viewer" }) {
    const normalized = normalizeUsername(username);
    if (!normalized || normalized.length > 200) throw new Error("Invalid username");
    if (String(password || "").length < 12) throw new Error("Password must contain at least 12 characters");
    if (!["viewer", "operator", "admin"].includes(role)) throw new Error("Invalid role");
    const salt = randomBytes(16).toString("hex");
    const digest = await passwordDigest(password, salt);
    const result = await database.query(
      `INSERT INTO app_users (id, username, password_hash, password_salt, role)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [randomUUID(), normalized, digest.toString("hex"), salt, role]
    );
    return publicUser(result.rows[0]);
  }

  async function ensureBootstrapUser({ username, password, role = "admin" } = {}) {
    const normalized = normalizeUsername(username);
    const count = await database.query("SELECT COUNT(*)::int AS count FROM app_users");
    if (Number(count.rows[0]?.count || 0) > 0) return null;
    if (!normalized || !password) {
      const error = new Error("Bootstrap auth credentials are required for the first user");
      error.code = "AUTH_BOOTSTRAP_REQUIRED";
      throw error;
    }
    return createUser({ username: normalized, password, role });
  }

  async function recoverAdmin({ username, password }) {
    const normalized = normalizeUsername(username);
    if (!normalized || normalized.length > 200) throw new Error("Invalid username");
    if (String(password || "").length < 12) {
      throw new Error("Password must contain at least 12 characters");
    }
    const salt = randomBytes(16).toString("hex");
    const digest = await passwordDigest(password, salt);
    const result = await database.query(
      `INSERT INTO app_users (id, username, password_hash, password_salt, role)
       VALUES ($1, $2, $3, $4, 'admin')
       ON CONFLICT (username) DO UPDATE SET
         password_hash = EXCLUDED.password_hash,
         password_salt = EXCLUDED.password_salt,
         role = 'admin',
         disabled_at = NULL,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [randomUUID(), normalized, digest.toString("hex"), salt]
    );
    await database.query(
      `UPDATE auth_sessions SET revoked_at = CURRENT_TIMESTAMP
       WHERE user_id = $1 AND revoked_at IS NULL`,
      [result.rows[0].id]
    );
    return publicUser(result.rows[0]);
  }

  async function login(username, password) {
    const result = await database.query(
      `SELECT * FROM app_users WHERE username = $1 AND disabled_at IS NULL`,
      [normalizeUsername(username)]
    );
    const row = result.rows[0];
    const candidate = await passwordDigest(password, row?.password_salt || randomBytes(16).toString("hex"));
    if (!row || !constantTimeHexEqual(candidate.toString("hex"), row.password_hash)) {
      const error = new Error("Invalid username or password");
      error.code = "INVALID_CREDENTIALS";
      error.status = 401;
      throw error;
    }
    const token = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + sessionTtlMs);
    await database.query(
      `INSERT INTO auth_sessions (token_hash, user_id, csrf_hash, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [sha256(token), row.id, sha256(csrfToken), expiresAt]
    );
    return { token, csrfToken, expiresAt, user: publicUser(row) };
  }

  async function getSession(token) {
    if (!token) return null;
    const tokenHash = sha256(token);
    const now = new Date();
    const result = await database.query(
      `SELECT s.token_hash, s.csrf_hash, s.expires_at, u.id, u.username, u.role
       FROM auth_sessions s JOIN app_users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL
         AND s.expires_at > $2 AND u.disabled_at IS NULL`,
      [tokenHash, now]
    );
    if (!result.rowCount) return null;
    await database.query(
      "UPDATE auth_sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE token_hash = $1",
      [tokenHash]
    );
    const row = result.rows[0];
    return {
      tokenHash,
      csrfHash: row.csrf_hash,
      expiresAt: row.expires_at,
      user: publicUser(row)
    };
  }

  async function rotateCsrf(tokenHash) {
    const csrfToken = randomBytes(32).toString("base64url");
    await database.query("UPDATE auth_sessions SET csrf_hash = $2 WHERE token_hash = $1", [
      tokenHash,
      sha256(csrfToken)
    ]);
    return csrfToken;
  }

  async function revoke(tokenHash) {
    if (!tokenHash) return false;
    const result = await database.query(
      `UPDATE auth_sessions SET revoked_at = CURRENT_TIMESTAMP
       WHERE token_hash = $1 AND revoked_at IS NULL`,
      [tokenHash]
    );
    return result.rowCount > 0;
  }

  function setSessionCookie(res, token, expiresAt) {
    const parts = [
      `${cookieName}=${encodeURIComponent(token)}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      `Expires=${expiresAt.toUTCString()}`
    ];
    if (secureCookies) parts.push("Secure");
    res.setHeader("Set-Cookie", parts.join("; "));
  }

  function clearSessionCookie(res) {
    const parts = [
      `${cookieName}=`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      "Max-Age=0"
    ];
    if (secureCookies) parts.push("Secure");
    res.setHeader("Set-Cookie", parts.join("; "));
  }

  async function sessionMiddleware(req, _res, next) {
    try {
      const token = parseCookies(req.get("Cookie"))[cookieName];
      req.auth = await getSession(token);
      return next();
    } catch (error) {
      return next(error);
    }
  }

  return {
    createUser,
    ensureBootstrapUser,
    recoverAdmin,
    login,
    getSession,
    rotateCsrf,
    revoke,
    setSessionCookie,
    clearSessionCookie,
    sessionMiddleware,
    hashCsrfToken: sha256
  };
}
