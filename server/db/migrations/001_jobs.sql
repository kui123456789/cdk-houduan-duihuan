CREATE TABLE IF NOT EXISTS redeem_jobs (
  id UUID PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'queued',
  source TEXT NOT NULL DEFAULT 'api',
  credential_mode TEXT NOT NULL DEFAULT 'secret_ref',
  request_hash TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  event_sequence INTEGER NOT NULL DEFAULT 0 CHECK (event_sequence >= 0),
  worker_attempts INTEGER NOT NULL DEFAULT 0 CHECK (worker_attempts >= 0),
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  cancel_requested_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  error_code TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS redeem_jobs_queue_idx
  ON redeem_jobs (status, next_run_at, created_at);
CREATE INDEX IF NOT EXISTS redeem_jobs_lease_idx
  ON redeem_jobs (lease_expires_at)
  WHERE lease_owner IS NOT NULL;

CREATE TABLE IF NOT EXISTS redeem_job_items (
  id UUID PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES redeem_jobs(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  status TEXT NOT NULL DEFAULT 'queued',
  cdkey TEXT NOT NULL,
  cdkey_hash TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT '',
  account_hash TEXT,
  token_hash TEXT,
  secret_ref TEXT,
  attempt_sequence INTEGER NOT NULL DEFAULT 0 CHECK (attempt_sequence >= 0),
  result JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_code TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (job_id, ordinal),
  UNIQUE (job_id, cdkey_hash)
);

CREATE INDEX IF NOT EXISTS redeem_job_items_job_idx
  ON redeem_job_items (job_id, ordinal);
CREATE INDEX IF NOT EXISTS redeem_job_items_cdkey_idx
  ON redeem_job_items (cdkey_hash, status);

CREATE TABLE IF NOT EXISTS redeem_attempts (
  id UUID PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES redeem_jobs(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES redeem_job_items(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  status TEXT NOT NULL,
  trigger TEXT NOT NULL DEFAULT 'initial',
  cdkey_hash TEXT NOT NULL,
  account_hash TEXT,
  token_hash TEXT,
  upstream_reference TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_code TEXT,
  error_message TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (item_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS redeem_attempts_job_idx
  ON redeem_attempts (job_id, created_at);
CREATE INDEX IF NOT EXISTS redeem_attempts_item_idx
  ON redeem_attempts (item_id, attempt_number);
CREATE INDEX IF NOT EXISTS redeem_attempts_account_idx
  ON redeem_attempts (account_hash, created_at)
  WHERE account_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS redeem_events (
  id BIGSERIAL PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES redeem_jobs(id) ON DELETE CASCADE,
  item_id UUID REFERENCES redeem_job_items(id) ON DELETE CASCADE,
  attempt_id UUID REFERENCES redeem_attempts(id) ON DELETE SET NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (job_id, sequence)
);

CREATE INDEX IF NOT EXISTS redeem_events_job_idx
  ON redeem_events (job_id, sequence);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  id UUID PRIMARY KEY,
  scope TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  job_id UUID NOT NULL REFERENCES redeem_jobs(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ,
  UNIQUE (scope, key_hash)
);

CREATE INDEX IF NOT EXISTS idempotency_keys_job_idx
  ON idempotency_keys (job_id);

CREATE TABLE IF NOT EXISTS account_limits (
  account_hash TEXT PRIMARY KEY,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  window_started_at TIMESTAMPTZ,
  cooldown_until TIMESTAMPTZ,
  cooldown_reason TEXT,
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS account_limits_cooldown_idx
  ON account_limits (cooldown_until)
  WHERE cooldown_until IS NOT NULL;
