import { describe, expect, it } from "vitest";

import { setThemeProps } from "./ThemeImageShapeUtil";
import {
  ThemeImageShapeType,
  type ThemeImageShape,
  type ThemeImageShapeProps,
} from "./ThemeImageShape";
import type { TLAssetId, TLShapeCrop } from "tldraw";

const baseCrop: TLShapeCrop = {
  topLeft: { x: 0.1, y: 0.2 },
  bottomRight: { x: 0.9, y: 0.8 },
  isCircle: false,
};

function createShape(
  overrides: Partial<ThemeImageShapeProps> = {},
): ThemeImageShape {
  const props: ThemeImageShapeProps = {
    w: 100,
    h: 100,
    assetIdLight: "light-asset" as TLAssetId,
    assetIdDark: "dark-asset" as TLAssetId,
    syncThemeDimensionsAndCrops: true,
    playing: true,
    url: "",
    crop: null,
    flipX: false,
    flipY: false,
    altText: "",
    dimensionLight: { w: 100, h: 100 },
    dimensionDark: { w: 200, h: 200 },
    cropLight: null,
    cropDark: null,
    ...overrides,
  };

  return {
    id: "shape:theme-image",
    type: ThemeImageShapeType,
    typeName: "shape",
    isLocked: false,
    isGenerated: false,
    opacity: 1,
    parentId: "page:parent",
    index: "a1",
    x: 0,
    y: 0,
    rotation: 0,
    meta: {},
    props,
  } as unknown as ThemeImageShape;
}

describe("setThemeProps", () => {
  it("synchronizes dimensions and crops across themes with the same ratio when enabled", () => {
    const shape = createShape({
      dimensionLight: { w: 120, h: 80 },
      dimensionDark: { w: 300, h: 200 },
      cropLight: baseCrop,
      cropDark: baseCrop,
      syncThemeDimensionsAndCrops: true,
    });

    const result = setThemeProps(shape, false, {
      w: 60,
      h: 40,
      crop: baseCrop,
    });

    expect(result?.dimensionLight).toEqual({ w: 60, h: 40 });
    expect(result?.dimensionDark).toEqual({ w: 150, h: 100 });
    expect(result?.cropLight).toEqual(baseCrop);
    expect(result?.cropDark).toEqual(baseCrop);
  });

  it("does not synchronize when the flag is disabled on the shape", () => {
    const shape = createShape({
      dimensionLight: { w: 120, h: 80 },
      dimensionDark: { w: 300, h: 200 },
      syncThemeDimensionsAndCrops: false,
    });

    const result = setThemeProps(shape, false, {
      w: 60,
      h: 40,
      crop: baseCrop,
    });

    expect(result?.dimensionLight).toEqual({ w: 60, h: 40 });
    expect(result?.cropLight).toEqual(baseCrop);
    expect(result?.dimensionDark).toBeUndefined();
    expect(result?.cropDark).toBeUndefined();
  });
});
