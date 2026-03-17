CREATE TABLE IF NOT EXISTS document_assets (
  document_id TEXT NOT NULL REFERENCES documents(id),
  asset_key TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (document_id, asset_key)
);

CREATE INDEX IF NOT EXISTS idx_document_assets_user_id ON document_assets(user_id);
CREATE INDEX IF NOT EXISTS idx_document_assets_asset_key ON document_assets(asset_key);
