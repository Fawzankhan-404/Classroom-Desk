-- Account-scoped presentation preference. This does not grant Google roles or permissions.
CREATE TABLE IF NOT EXISTS classroom_desk_user_preferences (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES classroom_desk_users(id) ON DELETE CASCADE,
  experience TEXT NOT NULL CHECK (experience IN ('student','teacher')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
