CREATE TABLE IF NOT EXISTS assets (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  asset_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  stale_at INTEGER,
  PRIMARY KEY (document_id, asset_name)
);

CREATE INDEX IF NOT EXISTS idx_assets_document_stale_at
  ON assets(document_id, stale_at);
