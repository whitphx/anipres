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
  rotation: number;
}

export interface ThemeImageShapeProps
  extends Omit<TLImageShapeProps, "assetId"> {
  assetIdLight: TLAssetId | null;
  assetIdDark: TLAssetId | null;
  dimensionLight: ThemeDimension;
  dimensionDark: ThemeDimension;
  cropLight: TLShapeCrop | null;
  cropDark: TLShapeCrop | null;
}

export const themeImageShapeType = "theme-image" as const;

export type ThemeImageShape = TLBaseShape<
  typeof themeImageShapeType,
  ThemeImageShapeProps
>;

export const themeImageShapeProps: RecordProps<ThemeImageShape> = {
  w: T.nonZeroNumber,
  h: T.nonZeroNumber,
  playing: T.boolean,
  url: T.linkUrl,
  assetIdLight: T.string.nullable() as Validator<TLAssetId | null>,
  assetIdDark: T.string.nullable() as Validator<TLAssetId | null>,
  dimensionLight: T.object({
    w: T.nonZeroNumber,
    h: T.nonZeroNumber,
    rotation: T.number,
  }),
  dimensionDark: T.object({
    w: T.nonZeroNumber,
    h: T.nonZeroNumber,
    rotation: T.number,
  }),
  crop: ImageShapeCrop.nullable(),
  cropLight: ImageShapeCrop.nullable(),
  cropDark: ImageShapeCrop.nullable(),
  flipX: T.boolean,
  flipY: T.boolean,
  altText: T.string,
};
