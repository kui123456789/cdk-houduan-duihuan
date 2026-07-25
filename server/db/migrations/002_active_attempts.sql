CREATE UNIQUE INDEX IF NOT EXISTS redeem_attempts_active_cdk_uidx
  ON redeem_attempts (cdkey_hash)
  WHERE status IN ('queued', 'running');

CREATE TABLE IF NOT EXISTS idempotency_locks (
  scope TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (scope, key_hash)
);
