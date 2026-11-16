CREATE TABLE unassigned_students (
  id TEXT PRIMARY KEY NOT NULL COLLATE NOCASE,
  name TEXT NOT NULL DEFAULT ''
);
--> statement-breakpoint
CREATE INDEX students_by_login_id ON students (id COLLATE NOCASE);
