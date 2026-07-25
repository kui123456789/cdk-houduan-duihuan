DROP INDEX IF EXISTS redeem_events_actor_idx;
ALTER TABLE redeem_events DROP COLUMN IF EXISTS actor_id;
DROP TABLE IF EXISTS job_secrets;
DROP TABLE IF EXISTS auth_sessions;
DROP TABLE IF EXISTS app_users;
