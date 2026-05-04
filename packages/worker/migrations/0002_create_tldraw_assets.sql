-- Per-document blob storage tracker for tldraw's `TLAsset` records
-- (the bytes that user-uploaded images / videos resolve to). The
-- `tldraw_` prefix disambiguates from the generic word "assets":
-- this table is specifically about the lifecycle of binary blobs
-- referenced from tldraw shapes via `TLAssetStore`. Bytes themselves
-- live in R2; this table records (document_id, asset_name) bindings
-- plus GC state.
CREATE TABLE IF NOT EXISTS tldraw_assets (
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

CREATE INDEX IF NOT EXISTS idx_tldraw_assets_document_stale_at
  ON tldraw_assets(document_id, stale_at);
