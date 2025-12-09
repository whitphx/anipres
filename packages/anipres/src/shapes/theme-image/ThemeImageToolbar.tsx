import {
  Box,
  TLAsset,
  TLImageAsset,
  TLShapeId,
  TldrawUiButton,
  TldrawUiButtonIcon,
  TldrawUiButtonLabel,
  TldrawUiInput,
  TldrawUiContextualToolbar,
  useTranslation,
  useEditor,
  useValue,
} from "tldraw";
import { useCallback, useEffect, useMemo, useRef } from "react";

import {
  ThemeImageShapeType,
  type ThemeImageShape,
  type ThemeImageShapeProps,
} from "./ThemeImageShape";

interface ThemeImageToolbarProps {
  fallback?: React.ReactNode;
}

export function ThemeImageToolbar({ fallback }: ThemeImageToolbarProps) {
  const editor = useEditor();
  const shapeId = useValue(
    "theme image selection",
    () => {
      const onlySelectedShape = editor.getOnlySelectedShape();
      if (
        !onlySelectedShape ||
        onlySelectedShape.type !== ThemeImageShapeType
      ) {
        return null;
      }
      return onlySelectedShape.id;
    },
    [editor],
  );
  const showToolbar = useValue(
    "showToolbar",
    () => editor.isInAny("select.idle", "select.pointing_shape"),
    [editor],
  );
  const isLocked = useValue(
    "locked",
    () => (shapeId ? editor.getShape(shapeId)?.isLocked === true : false),
    [editor, shapeId],
  );

  if (!shapeId || !showToolbar || isLocked) {
    return <>{fallback}</>;
  }

  return <ThemeImageToolbarInner shapeId={shapeId} />;
}

function ThemeImageToolbarInner({ shapeId }: { shapeId: TLShapeId }) {
  const editor = useEditor();
  const msg = useTranslation();
  const camera = useValue("camera", () => editor.getCamera(), [editor]);
  const previousSelectionBounds = useRef<Box | undefined>();

  useEffect(() => {
    previousSelectionBounds.current = undefined;
  }, [camera]);

  const getSelectionBounds = useCallback(() => {
    if (previousSelectionBounds.current) {
      return previousSelectionBounds.current;
    }
    const fullBounds = editor.getSelectionScreenBounds();
    if (!fullBounds) return undefined;
    const bounds = new Box(fullBounds.x, fullBounds.y, fullBounds.width, 0);
    previousSelectionBounds.current = bounds;
    return bounds;
  }, [editor]);

  return (
    <TldrawUiContextualToolbar
      className="tlui-image__toolbar"
      getSelectionBounds={getSelectionBounds}
      label={msg("tool.theme-image-toolbar-title")}
    >
      <ThemeImageToolbarContent shapeId={shapeId} />
    </TldrawUiContextualToolbar>
  );
}

function ThemeImageToolbarContent({ shapeId }: { shapeId: TLShapeId }) {
  const editor = useEditor();
  const msg = useTranslation();
  const lightInputRef = useRef<HTMLInputElement>(null);
  const darkInputRef = useRef<HTMLInputElement>(null);

  const shape = useValue(
    "shape",
    () => editor.getShape<ThemeImageShape>(shapeId),
    [editor, shapeId],
  );

  const altText = shape?.props.altText ?? "";
  const syncThemeDimensionsAndCrops =
    shape?.props.syncThemeDimensionsAndCrops ?? true;
  const lightAsset = useMemo(() => {
    if (!shape?.props.assetIdLight) return null;
    return editor.getAsset<TLImageAsset>(shape.props.assetIdLight);
  }, [editor, shape]);
  const darkAsset = useMemo(() => {
    if (!shape?.props.assetIdDark) return null;
    return editor.getAsset<TLImageAsset>(shape.props.assetIdDark);
  }, [editor, shape]);

  const handleAltChange = useCallback(
    (next: string) => {
      if (!shape) return;
      editor.updateShape({
        id: shape.id,
        type: shape.type,
        props: { altText: next },
      });
    },
    [editor, shape],
  );

  const handleFileChosen = useCallback(
    async (file: File, isDark: boolean) => {
      if (!shape) return;
      const asset = await editor.getAssetForExternalContent({
        type: "file",
        file,
      });
      if (!asset) return;

      // Use natural size from the asset when replacing
      const w =
        "w" in asset.props
          ? (asset.props as TLImageAsset["props"]).w
          : shape.props.w;
      const h =
        "h" in asset.props
          ? (asset.props as TLImageAsset["props"]).h
          : shape.props.h;

      editor.createAssets([asset]);

      const assetKey: keyof ThemeImageShapeProps = isDark
        ? "assetIdDark"
        : "assetIdLight";
      const dimensionKey: keyof ThemeImageShapeProps = isDark
        ? "dimensionDark"
        : "dimensionLight";
      const cropKey: keyof ThemeImageShapeProps = isDark
        ? "cropDark"
        : "cropLight";
      editor.updateShape({
        id: shape.id,
        type: shape.type,
        props: {
          [assetKey]: asset.id,
          [dimensionKey]: {
            w,
            h,
          },
          [cropKey]: null,
        },
      });
    },
    [editor, shape],
  );

  const handleToggleSync = useCallback(() => {
    if (!shape) return;

    editor.updateShape({
      id: shape.id,
      type: shape.type,
      props: {
        syncThemeDimensionsAndCrops: !shape.props.syncThemeDimensionsAndCrops,
      },
    });
  }, [editor, shape]);

  const handleDownload = useCallback(
    async (asset: TLAsset | null | undefined) => {
      if (!asset || asset.type !== "image") return;
      const src = asset.props.src;
      if (!src) return;

      try {
        const response = await fetch(src);
        if (!response.ok) {
          console.error("Failed to download image:", response.statusText);
          return;
        }
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = asset.props.name || "image.png";
        a.click();
        setTimeout(() => {
          URL.revokeObjectURL(url);
        }, 100);
      } catch (error) {
        console.error("Failed to download image:", error);
      }
    },
    [],
  );

  return (
    <div className="tlui-toolbar__row" style={{ gap: 8 }}>
      <input
        ref={lightInputRef}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        aria-label="Upload light image"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFileChosen(file, false);
          e.target.value = "";
        }}
      />
      <input
        ref={darkInputRef}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        aria-label="Upload dark image"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFileChosen(file, true);
          e.target.value = "";
        }}
      />

      <TldrawUiButton
        type="normal"
        title={msg("tool.theme-image-upload")}
        onClick={() => lightInputRef.current?.click()}
      >
        <TldrawUiButtonIcon icon="upload" />
        <TldrawUiButtonLabel>
          {msg("tool.theme-image-upload")}
        </TldrawUiButtonLabel>
      </TldrawUiButton>
      <TldrawUiButton
        type="normal"
        title={msg("tool.theme-image-upload-dark")}
        onClick={() => darkInputRef.current?.click()}
      >
        <TldrawUiButtonIcon icon="upload" />
        <TldrawUiButtonLabel>
          {msg("tool.theme-image-upload-dark")}
        </TldrawUiButtonLabel>
      </TldrawUiButton>

      <div className="tlui-toolbar__divider" />

      <TldrawUiButton
        type="normal"
        title={msg("tool.theme-image-download") ?? "Download light image"}
        onClick={() => handleDownload(lightAsset)}
        disabled={!lightAsset}
      >
        <TldrawUiButtonIcon icon="download" />
        <TldrawUiButtonLabel>
          {msg("tool.theme-image-download")}
        </TldrawUiButtonLabel>
      </TldrawUiButton>
      <TldrawUiButton
        type="normal"
        title={msg("tool.theme-image-download-dark") ?? "Download dark image"}
        onClick={() => handleDownload(darkAsset)}
        disabled={!darkAsset}
      >
        <TldrawUiButtonIcon icon="download" />
        <TldrawUiButtonLabel>
          {msg("tool.theme-image-download-dark")}
        </TldrawUiButtonLabel>
      </TldrawUiButton>

      <div className="tlui-toolbar__divider" />

      <TldrawUiButton
        type="normal"
        title={msg("tool.theme-image-sync")}
        onClick={handleToggleSync}
        aria-pressed={syncThemeDimensionsAndCrops}
      >
        <TldrawUiButtonIcon icon="link" />
        <TldrawUiButtonLabel>
          {msg("tool.theme-image-sync")}
          {syncThemeDimensionsAndCrops ? " (On)" : " (Off)"}
        </TldrawUiButtonLabel>
      </TldrawUiButton>

      <div className="tlui-toolbar__divider" />

      <TldrawUiInput
        value={altText}
        label="ALT"
        onValueChange={handleAltChange}
      />
    </div>
  );
}
