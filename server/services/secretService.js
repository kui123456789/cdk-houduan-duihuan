import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";

function decodeKey(value) {
  if (Buffer.isBuffer(value) && value.length === 32) return Buffer.from(value);
  const text = String(value || "").trim();
  if (/^[a-f0-9]{64}$/i.test(text)) return Buffer.from(text, "hex");
  const decoded = Buffer.from(text, "base64");
  if (decoded.length === 32) return decoded;
  const error = new Error("SECRET_ENCRYPTION_KEY must encode exactly 32 bytes");
  error.code = "INVALID_SECRET_ENCRYPTION_KEY";
  throw error;
}

function referenceId(reference) {
  const match = /^db-secret:\/\/([0-9a-f-]{36})$/i.exec(String(reference || ""));
  return match?.[1] || "";
}

export function createSecretService({ database, encryptionKey, keyVersion = 1 } = {}) {
  if (!database?.query) throw new TypeError("database is required");
  const key = decodeKey(encryptionKey ?? process.env.SECRET_ENCRYPTION_KEY);

  return {
    async put(value, options = {}) {
      const id = randomUUID();
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(value), "utf8"),
        cipher.final()
      ]);
      const authTag = cipher.getAuthTag();
      await database.query(
        `INSERT INTO job_secrets (id, ciphertext, iv, auth_tag, key_version, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          id,
          ciphertext.toString("base64"),
          iv.toString("base64"),
          authTag.toString("base64"),
          keyVersion,
          options.expiresAt || null
        ]
      );
      return `db-secret://${id}`;
    },

    async get(reference) {
      const id = referenceId(reference);
      if (!id) return null;
      const result = await database.query(
        "SELECT ciphertext, iv, auth_tag, expires_at FROM job_secrets WHERE id = $1",
        [id]
      );
      if (!result.rowCount) return null;
      const row = result.rows[0];
      if (row.expires_at && new Date(row.expires_at) <= new Date()) return null;
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(row.iv, "base64")
      );
      decipher.setAuthTag(Buffer.from(row.auth_tag, "base64"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(row.ciphertext, "base64")),
        decipher.final()
      ]).toString("utf8");
      return JSON.parse(plaintext);
    },

    async delete(reference) {
      const id = referenceId(reference);
      if (!id) return false;
      const result = await database.query("DELETE FROM job_secrets WHERE id = $1", [id]);
      return result.rowCount > 0;
    }
  };
}
