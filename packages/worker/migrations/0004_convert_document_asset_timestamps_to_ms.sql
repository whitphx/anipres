UPDATE document_assets
SET
  created_at = created_at * 1000,
  stale_at = CASE
    WHEN stale_at IS NULL THEN NULL
    ELSE stale_at * 1000
  END
WHERE created_at < 1000000000000;
