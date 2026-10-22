-- One-time, owner-authorized authentication reset. This migration is guarded
-- by the verified 2026-10-22 backup's aggregate counts. If live counts differ,
-- CHECK constraints abort the migration before the reset is applied.
INSERT INTO classroom_desk_auth_reset_guard (id, asserted)
SELECT 1, CASE WHEN
  (SELECT count(*) FROM classroom_desk_users) = 11 AND
  (SELECT count(*) FROM classroom_desk_users WHERE google_subject IS NOT NULL OR google_subject_hash IS NOT NULL) = 11 AND
  (SELECT count(*) FROM classroom_desk_users WHERE google_subject_hash IS NOT NULL) = 4 AND
  (SELECT count(*) FROM classroom_desk_auth_records WHERE kind = 'client') = 13 AND
  (SELECT count(*) FROM classroom_desk_auth_records WHERE kind = 'grant') = 30 AND
  (SELECT count(*) FROM classroom_desk_auth_records WHERE kind = 'refresh') = 7 AND
  (SELECT count(*) FROM classroom_desk_sessions) = 22 AND
  (SELECT count(*) FROM classroom_desk_connections) = 7 AND
  (SELECT count(*) FROM classroom_desk_oauth_accounts) = 0 AND
  (SELECT count(*) FROM classroom_desk_subscriptions) = 1 AND
  (SELECT count(*) FROM classroom_desk_payments) = 6 AND
  (SELECT count(*) FROM classroom_desk_trials) = 11 AND
  (SELECT count(*) FROM classroom_desk_webhook_events) = 16 AND
  (SELECT count(*) FROM classroom_desk_trials WHERE status = 'active' AND starts_at = '2026-10-22T00:00:00.000Z' AND expires_at = '2026-10-29T00:00:00.000Z') = 3 AND
  (SELECT count(*) FROM classroom_desk_detached_google_identities) = 0
THEN 1 ELSE 0 END;

-- Preserve each prior binding in an app-inaccessible table before detaching it.
INSERT INTO classroom_desk_detached_google_identities
  (account_id, google_subject, google_subject_hash, detached_at, reason)
SELECT id, google_subject, google_subject_hash,
  strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'owner_authorized_auth_reset'
FROM classroom_desk_users
WHERE google_subject IS NOT NULL OR google_subject_hash IS NOT NULL;

UPDATE classroom_desk_users
SET google_subject = NULL, google_subject_hash = NULL
WHERE google_subject IS NOT NULL OR google_subject_hash IS NOT NULL;

DELETE FROM classroom_desk_auth_records WHERE kind IN ('grant', 'refresh');
DELETE FROM classroom_desk_sessions;
DELETE FROM classroom_desk_connections;

INSERT INTO classroom_desk_auth_reset_guard (id, asserted)
SELECT 2, CASE WHEN
  (SELECT count(*) FROM classroom_desk_users) = 11 AND
  (SELECT count(*) FROM classroom_desk_users WHERE google_subject IS NOT NULL OR google_subject_hash IS NOT NULL) = 0 AND
  (SELECT count(*) FROM classroom_desk_detached_google_identities) = 11 AND
  (SELECT count(*) FROM classroom_desk_auth_records WHERE kind = 'client') = 13 AND
  (SELECT count(*) FROM classroom_desk_auth_records WHERE kind IN ('grant', 'refresh')) = 0 AND
  (SELECT count(*) FROM classroom_desk_sessions) = 0 AND
  (SELECT count(*) FROM classroom_desk_connections) = 0 AND
  (SELECT count(*) FROM classroom_desk_oauth_accounts) = 0 AND
  (SELECT count(*) FROM classroom_desk_subscriptions) = 1 AND
  (SELECT count(*) FROM classroom_desk_payments) = 6 AND
  (SELECT count(*) FROM classroom_desk_trials) = 11 AND
  (SELECT count(*) FROM classroom_desk_webhook_events) = 16 AND
  (SELECT count(*) FROM classroom_desk_trials WHERE status = 'active' AND starts_at = '2026-10-22T00:00:00.000Z' AND expires_at = '2026-10-29T00:00:00.000Z') = 3
THEN 1 ELSE 0 END;

INSERT INTO classroom_desk_auth_reset_audit
  (id, applied_at, reason, detached_users, revoked_grants, revoked_refresh_records,
   revoked_sessions, removed_connection_mappings, preserved_oauth_clients,
   preserved_trials, preserved_subscriptions, preserved_payments, preserved_webhook_events)
SELECT lower(hex(randomblob(16))), strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  'owner_authorized_auth_reset', 11, 30, 7, 22, 7, 13, 11, 1, 6, 16;

DELETE FROM classroom_desk_auth_reset_guard;
