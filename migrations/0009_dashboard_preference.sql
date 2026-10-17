ALTER TABLE classroom_desk_users
  ADD COLUMN dashboard_preference TEXT
  CHECK (dashboard_preference IN ('student', 'teacher'));
