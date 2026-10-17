ALTER TABLE classroom_desk_users ADD COLUMN profile_ciphertext TEXT;
ALTER TABLE classroom_desk_users ADD COLUMN google_subject_hash TEXT;
ALTER TABLE classroom_desk_users ADD COLUMN email_hash TEXT;
ALTER TABLE classroom_desk_users ADD COLUMN display_name_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS classroom_desk_users_google_subject_hash_idx
  ON classroom_desk_users(google_subject_hash) WHERE google_subject_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS classroom_desk_users_email_hash_idx
  ON classroom_desk_users(email_hash) WHERE email_hash IS NOT NULL;
