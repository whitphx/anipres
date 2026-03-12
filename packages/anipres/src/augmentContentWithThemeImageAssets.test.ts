import { describe, expect, it } from "vitest";

import { augmentContentWithThemeImageAssets } from "./augmentContentWithThemeImageAssets";
import { ThemeImageShapeType } from "./shapes/theme-image/ThemeImageShape";
import type { TLAsset, TLAssetId, TLContent, TLShape } from "tldraw";

function createThemeImageShape(overrides: {
  assetIdLight?: string | null;
  assetIdDark?: string | null;
}): TLShape {
  return {
    id: "shape:theme-image-1",
    type: ThemeImageShapeType,
    props: {
      assetIdLight: overrides.assetIdLight ?? null,
      assetIdDark: overrides.assetIdDark ?? null,
    },
  } as unknown as TLShape;
}

function createAsset(id: string): TLAsset {
  return {
    id: id as TLAssetId,
    typeName: "asset",
    type: "image",
    props: { src: `data:image/png;base64,${id}` },
  } as unknown as TLAsset;
}

function createContent(shapes: TLShape[], assets: TLAsset[] = []): TLContent {
  return {
    shapes,
    rootShapeIds: shapes.map((s) => s.id),
    assets,
    bindings: [],
    schema: {} as TLContent["schema"],
  };
}

describe("augmentContentWithThemeImageAssets", () => {
  it("adds both light and dark assets to content", () => {
    const lightAsset = createAsset("asset:light");
    const darkAsset = createAsset("asset:dark");
    const shape = createThemeImageShape({
      assetIdLight: "asset:light",
      assetIdDark: "asset:dark",
    });
    const content = createContent([shape]);
    const assetMap = new Map<string, TLAsset>([
      ["asset:light", lightAsset],
      ["asset:dark", darkAsset],
    ]);

    augmentContentWithThemeImageAssets(content, (id) => assetMap.get(id));

    expect(content.assets).toHaveLength(2);
    expect(content.assets).toContainEqual(lightAsset);
    expect(content.assets).toContainEqual(darkAsset);
  });

  it("does not duplicate assets already present in content", () => {
    const lightAsset = createAsset("asset:light");
    const darkAsset = createAsset("asset:dark");
    const shape = createThemeImageShape({
      assetIdLight: "asset:light",
      assetIdDark: "asset:dark",
    });
    const content = createContent([shape], [lightAsset]);
    const assetMap = new Map<string, TLAsset>([
      ["asset:light", lightAsset],
      ["asset:dark", darkAsset],
    ]);

    augmentContentWithThemeImageAssets(content, (id) => assetMap.get(id));

    expect(content.assets).toHaveLength(2);
    expect(content.assets).toContainEqual(lightAsset);
    expect(content.assets).toContainEqual(darkAsset);
  });

  it("handles null asset IDs gracefully", () => {
    const shape = createThemeImageShape({
      assetIdLight: null,
      assetIdDark: null,
    });
    const content = createContent([shape]);

    augmentContentWithThemeImageAssets(content, () => undefined);

    expect(content.assets).toHaveLength(0);
  });

  it("skips shapes that are not ThemeImage", () => {
    const otherShape = {
      id: "shape:text-1",
      type: "text",
      props: { text: "hello" },
    } as unknown as TLShape;
    const content = createContent([otherShape]);

    augmentContentWithThemeImageAssets(content, () => undefined);

    expect(content.assets).toHaveLength(0);
  });

  it("skips asset IDs that fail validation", () => {
    const shape = createThemeImageShape({
      assetIdLight: "not-a-valid-asset-id", // missing "asset:" prefix
      assetIdDark: null,
    });
    const content = createContent([shape]);

    augmentContentWithThemeImageAssets(content, () => undefined);

    expect(content.assets).toHaveLength(0);
  });

  it("handles when only one theme has an asset", () => {
    const lightAsset = createAsset("asset:light");
    const shape = createThemeImageShape({
      assetIdLight: "asset:light",
      assetIdDark: null,
    });
    const content = createContent([shape]);
    const assetMap = new Map<string, TLAsset>([["asset:light", lightAsset]]);

    augmentContentWithThemeImageAssets(content, (id) => assetMap.get(id));

    expect(content.assets).toHaveLength(1);
    expect(content.assets).toContainEqual(lightAsset);
  });

  it("does not duplicate when both themes reference the same asset", () => {
    const sharedAsset = createAsset("asset:shared");
    const shape = createThemeImageShape({
      assetIdLight: "asset:shared",
      assetIdDark: "asset:shared",
    });
    const content = createContent([shape]);
    const assetMap = new Map<string, TLAsset>([["asset:shared", sharedAsset]]);

    augmentContentWithThemeImageAssets(content, (id) => assetMap.get(id));

    expect(content.assets).toHaveLength(1);
    expect(content.assets).toContainEqual(sharedAsset);
  });
});
