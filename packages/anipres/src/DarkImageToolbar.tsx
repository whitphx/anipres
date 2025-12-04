import { ChangeEvent, useCallback } from "react";
import {
  Box,
  TLAsset,
  TLImageAsset,
  TLShapeId,
  useEditor,
  useTranslation,
  useValue,
} from "tldraw";
import { TldrawUiContextualToolbar } from "tldraw";
import { ThemeImageShape, ThemeImageShapeType } from "./DarkModeImageShapeUtil";

export const ThemeImageToolbar = () => {
  const editor = useEditor();
  const msg = useTranslation();

  const selectedShapeId = useValue(
    "dark image selection",
    () => {
      const shape = editor.getOnlySelectedShape() as ThemeImageShape | null;
      return shape?.type === ThemeImageShapeType
        ? (shape.id as TLShapeId)
        : null;
    },
    [editor],
  );

  const showToolbar = useValue(
    "show dark image toolbar",
    () => editor.isInAny("select.idle", "select.pointing_shape", "select.crop"),
    [editor],
  );

  const isLocked = useValue(
    "dark image locked",
    () =>
      selectedShapeId
        ? editor.getShape<ThemeImageShape>(selectedShapeId)?.isLocked
        : false,
    [editor, selectedShapeId],
  );

  if (!selectedShapeId || !showToolbar || isLocked) {
    return null;
  }

  const getSelectionBounds = () => {
    const screenBounds = editor.getSelectionScreenBounds();
    if (!screenBounds) {
      return undefined;
    }
    return new Box(screenBounds.x, screenBounds.y, screenBounds.width, 0);
  };

  return (
    <TldrawUiContextualToolbar
      className="tlui-dark-image__toolbar"
      getSelectionBounds={getSelectionBounds}
      label={msg("tool.image-toolbar-title")}
    >
      <DarkImageToolbarContent shapeId={selectedShapeId} />
    </TldrawUiContextualToolbar>
  );
};

const DarkImageToolbarContent = ({ shapeId }: { shapeId: TLShapeId }) => {
  const editor = useEditor();

  const shape = useValue(
    "dark image shape",
    () => editor.getShape<ThemeImageShape>(shapeId),
    [editor, shapeId],
  );

  const handleFileChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>, target: "light" | "dark") => {
      const file = event.target.files?.[0];
      if (!file || !shape) {
        return;
      }

      const asset = await editor.getAssetForExternalContent({
        type: "file",
        file,
      });
      if (!asset || asset.type !== "image") {
        return;
      }
      const imageAsset = asset as TLImageAsset;

      const alreadyExists = editor.getAsset(asset.id);
      if (!alreadyExists) {
        editor.createAssets([asset]);
      }

      const hasAnyAsset =
        shape.props.assetId != null || shape.props.darkAssetId != null;
      const shouldResize = !hasAnyAsset;
      const maxSide = 512;
      const scale = Math.min(
        1,
        maxSide / Math.max(imageAsset.props.w, imageAsset.props.h),
      );
      const nextW = imageAsset.props.w * scale;
      const nextH = imageAsset.props.h * scale;

      const propsUpdate =
        target === "light"
          ? { assetId: asset.id, url: "" }
          : { darkAssetId: asset.id, darkUrl: "" };

      editor.updateShapes([
        {
          id: shape.id,
          type: shape.type,
          props: {
            ...propsUpdate,
            ...(shouldResize
              ? {
                  w: nextW,
                  h: nextH,
                  crop: null,
                }
              : null),
          },
        },
      ]);
    },
    [editor, shape],
  );

  const handleAltChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      if (!shape) {
        return;
      }
      editor.updateShapes([
        {
          id: shape.id,
          type: shape.type,
          props: { altText: event.target.value },
        },
      ]);
    },
    [editor, shape],
  );

  const handleDownload = useCallback(
    async (target: "light" | "dark") => {
      if (!shape) {
        return;
      }
      const assetId =
        target === "light" ? shape.props.assetId : shape.props.darkAssetId;
      if (!assetId) {
        return;
      }
      const asset = editor.getAsset(assetId) as TLAsset | undefined;
      if (!asset || asset.type !== "image") {
        return;
      }
      const src = (asset.props as TLImageAsset["props"]).src;
      if (!src) {
        return;
      }
      const link = document.createElement("a");
      link.href = src;
      link.download =
        asset?.props.name ?? (target === "dark" ? "dark-image" : "light-image");
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    },
    [editor, shape],
  );

  if (!shape) {
    return null;
  }

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "6px 8px",
      }}
    >
      <strong>Themed Image</strong>
      <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <span>Light</span>
        <input
          type="file"
          accept="image/*"
          onChange={(ev) => handleFileChange(ev, "light")}
        />
        <button type="button" onClick={() => handleDownload("light")}>
          Download
        </button>
      </label>
      <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <span>Dark</span>
        <input
          type="file"
          accept="image/*"
          onChange={(ev) => handleFileChange(ev, "dark")}
        />
        <button type="button" onClick={() => handleDownload("dark")}>
          Download
        </button>
      </label>
      <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <span>Alt</span>
        <input
          type="text"
          value={shape.props.altText}
          onChange={handleAltChange}
          placeholder="Alt text"
          style={{ minWidth: 140 }}
        />
      </label>
    </div>
  );
};
