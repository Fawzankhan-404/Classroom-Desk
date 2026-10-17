ALTER TABLE classroom_desk_link_tokens ADD COLUMN consumed_by TEXT;
CREATE INDEX IF NOT EXISTS classroom_desk_link_tokens_expiry_idx ON classroom_desk_link_tokens(expires_at);
