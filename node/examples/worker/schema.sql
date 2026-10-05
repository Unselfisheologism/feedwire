CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  type TEXT NOT NULL,
  severity TEXT NOT NULL,
  summary TEXT NOT NULL,
  payload TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS feedback_created ON feedback (created_at);
CREATE INDEX IF NOT EXISTS feedback_status ON feedback (status, created_at);
