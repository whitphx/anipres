CREATE TABLE IF NOT EXISTS assets (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  asset_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  -- Refreshed whenever the live room snapshot still references the asset.
  last_seen_at INTEGER NOT NULL,
  -- Set when an asset drops out of the current snapshot. GC waits out a grace
  -- period before deleting the blob so undo/redo can still recover it.
  stale_at INTEGER,
  PRIMARY KEY (document_id, asset_name)
);

CREATE INDEX IF NOT EXISTS idx_assets_document_stale_at
  ON assets(document_id, stale_at);
