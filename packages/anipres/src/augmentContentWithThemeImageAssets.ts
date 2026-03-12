import { assetIdValidator } from "tldraw";
import type { TLAsset, TLAssetId, TLContent } from "tldraw";
import { ThemeImageShapeType } from "./shapes/theme-image/ThemeImageShape";

/**
 * Mutates `content` to include ThemeImage assets (`assetIdLight` / `assetIdDark`)
 * that tldraw's default content serialization misses.
 */
export function augmentContentWithThemeImageAssets(
  content: TLContent,
  getAsset: (id: TLAssetId) => TLAsset | undefined,
): void {
  const seenAssetIds = new Set<TLAssetId>(content.assets.map((a) => a.id));
  for (const shape of content.shapes) {
    if (shape.type !== ThemeImageShapeType) continue;
    const props = shape.props as Record<string, unknown>;
    for (const key of ["assetIdLight", "assetIdDark"] as const) {
      const rawValue = props[key];
      if (!rawValue) continue;
      let assetId: TLAssetId;
      try {
        assetId = assetIdValidator.validate(rawValue);
      } catch {
        continue;
      }
      if (seenAssetIds.has(assetId)) continue;
      seenAssetIds.add(assetId);
      const asset = getAsset(assetId);
      if (asset) {
        content.assets.push(asset);
      }
    }
  }
}
