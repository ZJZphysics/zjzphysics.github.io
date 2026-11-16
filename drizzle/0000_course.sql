CREATE TABLE course (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  results_visible INTEGER NOT NULL DEFAULT 0 CHECK (results_visible IN (0, 1))
);
--> statement-breakpoint
INSERT INTO course (id) VALUES (1);
--> statement-breakpoint
CREATE TABLE groups (
  id INTEGER PRIMARY KEY CHECK (id BETWEEN 1 AND 8),
  title TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'open', 'closed')),
  deck_key TEXT,
  deck_name TEXT,
  pdf_key TEXT,
  pdf_name TEXT
);
--> statement-breakpoint
INSERT INTO groups (id) VALUES (1), (2), (3), (4), (5), (6), (7), (8);
--> statement-breakpoint
CREATE UNIQUE INDEX one_open_group ON groups (state) WHERE state = 'open';
--> statement-breakpoint
CREATE TABLE students (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  group_id INTEGER NOT NULL REFERENCES groups(id),
  code_hash TEXT NOT NULL UNIQUE
);
--> statement-breakpoint
CREATE TABLE scores (
  student_id TEXT NOT NULL REFERENCES students(id),
  group_id INTEGER NOT NULL REFERENCES groups(id),
  value INTEGER NOT NULL CHECK (typeof(value) = 'integer' AND value BETWEEN 0 AND 100),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (student_id, group_id)
);
--> statement-breakpoint
CREATE INDEX scores_by_group ON scores (group_id);
--> statement-breakpoint
CREATE TRIGGER validate_score BEFORE INSERT ON scores
BEGIN
  SELECT CASE WHEN (SELECT state FROM groups WHERE id = NEW.group_id) <> 'open'
    THEN RAISE(ABORT, 'round_not_open') END;
  SELECT CASE WHEN (SELECT group_id FROM students WHERE id = NEW.student_id) = NEW.group_id
    THEN RAISE(ABORT, 'same_group') END;
END;
--> statement-breakpoint
CREATE TRIGGER protect_scored_membership BEFORE UPDATE OF group_id ON students
WHEN OLD.group_id <> NEW.group_id AND EXISTS (SELECT 1 FROM scores WHERE student_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'group_locked');
END;
