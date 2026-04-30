import * as v from "valibot";
import { assetNameSchema } from "./schemas";
import type { AppContext } from "./types";

// Asset-storage / GC / lifecycle module — scheduled GC passes,
// soft-delete sweeps, room→DB asset reconciliation. The asset route
// handlers live in `./routes/document-assets.ts`.

const STALE_ASSET_RETENTION_MS = 24 * 60 * 60 * 1000; // 24 hours
const DOCUMENT_DELETE_BATCH_SIZE = 128;

const DOCUMENT_ASSET_PREFIX = "documents";

type SnapshotRecord = {
  id: string;
  typeName: string;
  props?: Record<string, unknown>;
};

function getDocumentAssetPrefix(documentId: string) {
  return `${DOCUMENT_ASSET_PREFIX}/${documentId}/`;
}

export function getDocumentAssetKey(documentId: string, assetName: string) {
  return `${getDocumentAssetPrefix(documentId)}${assetName}`;
}

function getAssetNameFromDocumentAssetSrc(src: string, documentId: string) {
  try {
    const url = new URL(src, "https://anipres.invalid");
    const prefix = `/api/documents/${encodeURIComponent(documentId)}/assets/`;
    if (!url.pathname.startsWith(prefix)) {
      return null;
    }

    const encodedAssetName = url.pathname.slice(prefix.length);
    const assetName = decodeURIComponent(encodedAssetName);
    return v.safeParse(assetNameSchema, assetName).success ? assetName : null;
  } catch {
    return null;
  }
}

async function scheduleDocumentDeletion(
  c: AppContext,
  documentId: string,
): Promise<void> {
  const room = c.env.DOCUMENT_SYNC_ROOM.getByName(documentId);
  await room.claimDocument(documentId);
  await room.startDelete();
}

async function deleteDocumentAssetPrefixBatch(
  bucket: R2Bucket,
  documentId: string,
  cursor?: string,
) {
  const prefix = getDocumentAssetPrefix(documentId);
  const result = await bucket.list({
    prefix,
    cursor,
    limit: DOCUMENT_DELETE_BATCH_SIZE,
  });
  if (result.objects.length > 0) {
    await bucket.delete(result.objects.map((object) => object.key));
  }

  return result.truncated ? result.cursor : null;
}

function getInClausePlaceholders(length: number) {
  return Array.from({ length }, () => "?").join(", ");
}

async function clearReferencedDocumentAssets(
  env: AppContext["env"],
  documentId: string,
  assetNames: readonly string[],
  now: number,
) {
  if (assetNames.length === 0) {
    return;
  }

  await env.DB.prepare(
    `UPDATE tldraw_assets
     SET last_seen_at = ?, stale_at = NULL
     WHERE document_id = ?
       AND asset_name IN (${getInClausePlaceholders(assetNames.length)})`,
  )
    .bind(now, documentId, ...assetNames)
    .run();
}

async function markUnreferencedDocumentAssetsStale(
  env: AppContext["env"],
  documentId: string,
  referencedAssetNames: readonly string[],
  now: number,
) {
  if (referencedAssetNames.length === 0) {
    await env.DB.prepare(
      `UPDATE tldraw_assets
       SET stale_at = COALESCE(stale_at, ?)
       WHERE document_id = ?`,
    )
      .bind(now, documentId)
      .run();
    return;
  }

  await env.DB.prepare(
    `UPDATE tldraw_assets
     SET stale_at = COALESCE(stale_at, ?)
     WHERE document_id = ?
       AND asset_name NOT IN (${getInClausePlaceholders(referencedAssetNames.length)})`,
  )
    .bind(now, documentId, ...referencedAssetNames)
    .run();
}

async function getNextDocumentAssetGcAt(
  env: AppContext["env"],
  documentId: string,
) {
  const row = await env.DB.prepare(
    `SELECT MIN(stale_at) AS stale_at
     FROM tldraw_assets
     WHERE document_id = ? AND stale_at IS NOT NULL`,
  )
    .bind(documentId)
    .first<{ stale_at: number | null }>();
  return row?.stale_at === null || row?.stale_at === undefined
    ? null
    : row.stale_at + STALE_ASSET_RETENTION_MS;
}

export async function reconcileDocumentAssets(
  env: AppContext["env"],
  documentId: string,
  referencedAssetNames: readonly string[],
) {
  const now = Date.now();
  // The live room snapshot is only safe to treat as "currently referenced".
  // We mark missing assets stale here, then delete them later after a grace
  // period so undo/redo can still restore older asset URLs.
  await clearReferencedDocumentAssets(
    env,
    documentId,
    referencedAssetNames,
    now,
  );
  await markUnreferencedDocumentAssetsStale(
    env,
    documentId,
    referencedAssetNames,
    now,
  );
  return getNextDocumentAssetGcAt(env, documentId);
}

export async function runDocumentAssetGc(
  env: AppContext["env"],
  documentId: string,
) {
  const cutoff = Date.now() - STALE_ASSET_RETENTION_MS;
  const expiredAssets = await env.DB.prepare(
    `SELECT asset_name
     FROM tldraw_assets
     WHERE document_id = ?
       AND stale_at IS NOT NULL
       AND stale_at <= ?`,
  )
    .bind(documentId, cutoff)
    .all<{ asset_name: string }>();

  if (expiredAssets.results.length > 0) {
    const staleAssetNames = expiredAssets.results.map(
      ({ asset_name }) => asset_name,
    );
    try {
      // Re-check right before deleting blobs so a stale row that was revived by
      // a recent reconcile or undo does not lose its underlying object.
      const currentExpiredAssets = await env.DB.prepare(
        `SELECT asset_name
         FROM tldraw_assets
         WHERE document_id = ?
           AND stale_at IS NOT NULL
           AND stale_at <= ?
           AND asset_name IN (${getInClausePlaceholders(staleAssetNames.length)})`,
      )
        .bind(documentId, cutoff, ...staleAssetNames)
        .all<{ asset_name: string }>();
      const keys = currentExpiredAssets.results.map(({ asset_name }) =>
        getDocumentAssetKey(documentId, asset_name),
      );
      if (keys.length === 0) {
        return getNextDocumentAssetGcAt(env, documentId);
      }

      await env.ASSETS.delete(keys);
      await env.DB.prepare(
        `DELETE FROM tldraw_assets
         WHERE document_id = ?
           AND stale_at IS NOT NULL
           AND stale_at <= ?
           AND asset_name IN (${getInClausePlaceholders(staleAssetNames.length)})`,
      )
        .bind(documentId, cutoff, ...staleAssetNames)
        .run();
    } catch (error) {
      // Keep stale rows so the next alarm can retry blob deletion instead of
      // breaking the GC chain on a transient R2 failure.
      console.error("Failed to delete stale document assets", error);
    }
  }

  return getNextDocumentAssetGcAt(env, documentId);
}

export async function isDocumentDeleting(
  env: AppContext["env"],
  documentId: string,
) {
  const row = await env.DB.prepare(
    "SELECT deleting_at FROM documents WHERE id = ?",
  )
    .bind(documentId)
    .first<{ deleting_at: number | null }>();
  return row?.deleting_at !== null && row?.deleting_at !== undefined;
}

export function getReferencedDocumentAssetNames(
  snapshot: {
    documents: Array<{ state: SnapshotRecord }>;
  },
  documentId: string,
) {
  const records = snapshot.documents.map((document) => document.state);
  const assetsById = new Map<string, SnapshotRecord>();
  const referencedAssetIds = new Set<string>();

  for (const record of records) {
    if (record.typeName === "asset") {
      assetsById.set(record.id, record);
      continue;
    }

    if (record.typeName !== "shape") {
      continue;
    }

    const props = record.props;
    if (!props) {
      continue;
    }

    for (const key of ["assetId", "assetIdLight", "assetIdDark"] as const) {
      const assetId = props[key];
      if (typeof assetId === "string" && assetId.length > 0) {
        referencedAssetIds.add(assetId);
      }
    }
  }

  const assetNames = new Set<string>();
  for (const assetId of referencedAssetIds) {
    const asset = assetsById.get(assetId) as
      | (SnapshotRecord & { props?: { src?: unknown } })
      | undefined;
    const src = asset?.props?.src;
    if (typeof src !== "string") {
      continue;
    }

    const assetName = getAssetNameFromDocumentAssetSrc(src, documentId);
    if (assetName) {
      assetNames.add(assetName);
    }
  }

  return Array.from(assetNames).sort();
}

export async function finalizeDeletingDocument(
  env: AppContext["env"],
  documentId: string,
  cursor?: string,
) {
  const document = await env.DB.prepare(
    "SELECT 1 FROM documents WHERE id = ? AND deleting_at IS NOT NULL",
  )
    .bind(documentId)
    .first();
  if (!document) {
    return { completed: true, nextCursor: null };
  }

  const nextCursor = await deleteDocumentAssetPrefixBatch(
    env.ASSETS,
    documentId,
    cursor,
  );
  if (nextCursor !== null) {
    return { completed: false, nextCursor };
  }

  await env.DB.prepare(
    "DELETE FROM documents WHERE id = ? AND deleting_at IS NOT NULL",
  )
    .bind(documentId)
    .run();
  return { completed: true, nextCursor: null };
}

export async function startDocumentDeletion(
  c: AppContext,
  userId: number,
  documentId: string,
) {
  const { meta } = await c.env.DB.prepare(
    `UPDATE documents
     SET deleting_at = ?
     WHERE id = ?
       AND workspace_id IN (SELECT id FROM workspaces WHERE owner_user_id = ?)
       AND deleting_at IS NULL`,
  )
    .bind(Date.now(), documentId, userId)
    .run();
  if (meta.changes === 0) {
    return;
  }

  try {
    // Prefix cleanup can take long enough to exceed a request budget. Hand the
    // actual delete work to the document DO so `deleting_at` can remain a
    // retryable state until the R2 sweep finishes successfully.
    await scheduleDocumentDeletion(c, documentId);
  } catch (error) {
    // Only roll back the deleting state if this call actually transitioned the
    // document into deletion. Existing delete retries must stay hidden from
    // active routes so uploads/connects cannot race against unfinished cleanup.
    await c.env.DB.prepare(
      `UPDATE documents
       SET deleting_at = NULL
       WHERE id = ?
         AND workspace_id IN (SELECT id FROM workspaces WHERE owner_user_id = ?)
         AND deleting_at IS NOT NULL`,
    )
      .bind(documentId, userId)
      .run();
    throw error;
  }
}
