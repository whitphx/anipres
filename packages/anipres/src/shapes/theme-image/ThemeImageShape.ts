import { T, ImageShapeCrop } from "tldraw";
import type {
  TLAssetId,
  TLBaseShape,
  TLImageShapeProps,
  RecordProps,
  Validator,
  TLShapeCrop,
} from "tldraw";

export interface ThemeDimension {
  w: number;
  h: number;
}

export interface ThemeImageShapeProps
  extends Omit<TLImageShapeProps, "assetId"> {
  assetIdLight: TLAssetId | null;
  assetIdDark: TLAssetId | null;
  syncThemeDimensionsAndCrops: boolean;
  dimensionLight: ThemeDimension;
  dimensionDark: ThemeDimension;
  cropLight: TLShapeCrop | null;
  cropDark: TLShapeCrop | null;
}

export const ThemeImageShapeType = "theme-image" as const;

export type ThemeImageShape = TLBaseShape<
  typeof ThemeImageShapeType,
  ThemeImageShapeProps
>;

export const themeImageShapeProps: RecordProps<ThemeImageShape> = {
  w: T.nonZeroNumber,
  h: T.nonZeroNumber,
  playing: T.boolean,
  url: T.linkUrl,
  assetIdLight: T.string.nullable() as Validator<TLAssetId | null>,
  assetIdDark: T.string.nullable() as Validator<TLAssetId | null>,
  syncThemeDimensionsAndCrops: T.boolean,
  dimensionLight: T.object({
    w: T.nonZeroNumber,
    h: T.nonZeroNumber,
  }),
  dimensionDark: T.object({
    w: T.nonZeroNumber,
    h: T.nonZeroNumber,
  }),
  crop: ImageShapeCrop.nullable(),
  cropLight: ImageShapeCrop.nullable(),
  cropDark: ImageShapeCrop.nullable(),
  flipX: T.boolean,
  flipY: T.boolean,
  altText: T.string,
};

export function isCropEqual(
  cropA: TLShapeCrop | null,
  cropB: TLShapeCrop | null,
): boolean {
  if (cropA === cropB) return true;
  if (cropA == null || cropB == null) return false;
  return (
    cropA.topLeft.x === cropB.topLeft.x &&
    cropA.topLeft.y === cropB.topLeft.y &&
    cropA.bottomRight.x === cropB.bottomRight.x &&
    cropA.bottomRight.y === cropB.bottomRight.y &&
    cropA.isCircle === cropB.isCircle
  );
}
