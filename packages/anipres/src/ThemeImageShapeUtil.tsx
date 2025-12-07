import {
  BaseBoxShapeUtil,
  Editor,
  Ellipse2d,
  Geometry2d,
  HTMLContainer,
  MediaHelpers,
  Rectangle2d,
  SvgExportContext,
  TLAsset,
  TLAssetId,
  TLResizeInfo,
  TLShapePartial,
  Vec,
  WeakCache,
  getUncroppedSize,
  lerp,
  modulate,
  resizeBox,
  stopEventPropagation,
  structuredClone,
  toDomPrecision,
  useEditor,
  useImageOrVideoAsset,
  useIsDarkMode,
  useUniqueSafeId,
  useValue,
  usePrefersReducedMotion,
  TLCropInfo,
  getCropBox,
  TLShapeCrop,
} from "tldraw";
import classNames from "classnames";
import {
  memo,
  type PointerEventHandler,
  useCallback,
  useEffect,
  useState,
} from "react";
import {
  ThemeImageShape,
  ThemeImageShapeProps,
  ThemeImageShapeType,
  themeImageShapeProps,
  ThemeDimension,
} from "./ThemeImageShape";

const imageSvgExportCache = new WeakCache<TLAsset, Promise<string | null>>();

function resolveModeFallback(
  shape: ThemeImageShape,
  isDarkMode: boolean,
): "dark" | "light" | null {
  if (isDarkMode && shape.props.assetIdDark != null) {
    return "dark";
  }
  if (!isDarkMode && shape.props.assetIdLight != null) {
    return "light";
  }
  if (shape.props.assetIdLight != null) {
    return "light";
  }
  if (shape.props.assetIdDark != null) {
    return "dark";
  }
  return null;
}

function getThemeProps(
  current: ThemeImageShape,
  isDarkMode: boolean,
): { dimension: ThemeDimension; crop: TLShapeCrop | null } | null {
  const colorMode = resolveModeFallback(current, isDarkMode);
  if (colorMode == null) {
    return null;
  }

  const dimensionKey: keyof ThemeImageShapeProps =
    colorMode === "dark" ? "dimensionDark" : "dimensionLight";
  const cropKey: keyof ThemeImageShapeProps =
    colorMode === "dark" ? "cropDark" : "cropLight";

  return {
    dimension: current.props[dimensionKey],
    crop: current.props[cropKey],
  };
}

function setThemeProps(
  current: ThemeImageShape,
  isDarkMode: boolean,
  updates: {
    w?: number;
    h?: number;
    crop?: TLShapeCrop | null;
  },
): TLShapePartial<ThemeImageShape>["props"] | null {
  const colorMode = resolveModeFallback(current, isDarkMode);
  if (colorMode == null) {
    return null;
  }

  const dimensionKey: keyof ThemeImageShapeProps =
    colorMode === "dark" ? "dimensionDark" : "dimensionLight";
  const cropKey: keyof ThemeImageShapeProps =
    colorMode === "dark" ? "cropDark" : "cropLight";

  let isDimensionChanged = false;
  const newDimension: Partial<ThemeDimension> = {
    ...current.props[dimensionKey],
  };
  if (updates.w != null) {
    newDimension.w = updates.w;
    isDimensionChanged = true;
  }
  if (updates.h) {
    newDimension.h = updates.h;
    isDimensionChanged = true;
  }

  return {
    ...(isDimensionChanged ? { [dimensionKey]: newDimension } : {}),
    ...("crop" in updates ? { [cropKey]: updates.crop ?? null } : {}),
  };
}

export class ThemeImageShapeUtil extends BaseBoxShapeUtil<ThemeImageShape> {
  static override type = ThemeImageShapeType;
  static override props = themeImageShapeProps;

  override isAspectRatioLocked() {
    return true;
  }

  override canCrop() {
    return true;
  }

  override getDefaultProps(): ThemeImageShape["props"] {
    return {
      w: 100,
      h: 100,
      assetIdLight: null,
      assetIdDark: null,
      playing: true,
      url: "",
      crop: null,
      flipX: false,
      flipY: false,
      altText: "",
      dimensionLight: { w: 100, h: 100 },
      dimensionDark: { w: 100, h: 100 },
      cropLight: null,
      cropDark: null,
    };
  }

  override getGeometry(shape: ThemeImageShape): Geometry2d {
    if (shape.props.crop?.isCircle) {
      return new Ellipse2d({
        width: shape.props.w,
        height: shape.props.h,
        isFilled: true,
      });
    }

    return new Rectangle2d({
      width: shape.props.w,
      height: shape.props.h,
      isFilled: true,
    });
  }

  override getAriaDescriptor(shape: ThemeImageShape) {
    return shape.props.altText;
  }

  override onResize(
    shape: ThemeImageShape,
    info: TLResizeInfo<ThemeImageShape>,
  ) {
    let resized = resizeBox(shape, info);
    const { flipX, flipY } = info.initialShape.props;
    const { scaleX, scaleY, mode } = info;

    resized = {
      ...resized,
      props: {
        ...resized.props,
        flipX: scaleX < 0 !== flipX,
        flipY: scaleY < 0 !== flipY,
      },
    };
    // Sync width and height -> per-theme dimension prop.
    const isDarkMode = this.editor.user.getIsDarkMode();
    resized.props = {
      ...resized.props,
      ...setThemeProps(shape, isDarkMode, {
        w: resized.props.w,
        h: resized.props.h,
        crop: resized.props.crop,
      }),
    };
    if (!shape.props.crop) return resized;

    const flipCropHorizontally =
      (mode === "scale_shape" && scaleX === -1) ||
      (mode === "resize_bounds" && flipX !== resized.props.flipX);
    const flipCropVertically =
      (mode === "scale_shape" && scaleY === -1) ||
      (mode === "resize_bounds" && flipY !== resized.props.flipY);

    const { topLeft, bottomRight } = shape.props.crop;
    resized.props.crop = {
      topLeft: {
        x: flipCropHorizontally ? 1 - bottomRight.x : topLeft.x,
        y: flipCropVertically ? 1 - bottomRight.y : topLeft.y,
      },
      bottomRight: {
        x: flipCropHorizontally ? 1 - topLeft.x : bottomRight.x,
        y: flipCropVertically ? 1 - topLeft.y : bottomRight.y,
      },
      isCircle: shape.props.crop.isCircle,
    };
    return resized;
  }

  override onCrop(shape: ThemeImageShape, info: TLCropInfo<ThemeImageShape>) {
    const cropped = getCropBox(shape, info);
    if (cropped == null) {
      return;
    }

    const isDarkMode = this.editor.user.getIsDarkMode();

    const themeProps = getThemeProps(shape, isDarkMode);
    if (!themeProps) {
      return;
    }

    return {
      ...cropped,
      props: {
        ...cropped.props,
        ...setThemeProps(shape, isDarkMode, {
          w: cropped.props.w,
          h: cropped.props.h,
          crop: cropped.props.crop,
        }),
      },
    };
  }

  component(shape: ThemeImageShape) {
    return <ThemeImage shape={shape} />;
  }

  indicator(shape: ThemeImageShape) {
    const isCropping = this.editor.getCroppingShapeId() === shape.id;
    if (isCropping) return null;

    if (shape.props.crop?.isCircle) {
      return (
        <ellipse
          cx={toDomPrecision(shape.props.w / 2)}
          cy={toDomPrecision(shape.props.h / 2)}
          rx={toDomPrecision(shape.props.w / 2)}
          ry={toDomPrecision(shape.props.h / 2)}
        />
      );
    }

    return (
      <rect
        width={toDomPrecision(shape.props.w)}
        height={toDomPrecision(shape.props.h)}
      />
    );
  }

  override async toSvg(shape: ThemeImageShape, ctx: SvgExportContext) {
    const props = shape.props;
    const isDarkMode = ctx.isDarkMode ?? this.editor.user.getIsDarkMode();
    const assetId = isDarkMode ? props.assetIdDark : props.assetIdLight;
    if (!assetId) return null;

    const asset = this.editor.getAsset(assetId);
    if (!asset) return null;

    const { w } = getUncroppedSize(shape.props, props.crop);

    const src = await imageSvgExportCache.get(asset, async () => {
      let src = await ctx.resolveAssetUrl(asset.id, w);
      if (!src) return null;
      if (
        src.startsWith("blob:") ||
        src.startsWith("http") ||
        src.startsWith("/") ||
        src.startsWith("./")
      ) {
        src = (await getDataURIFromURL(src)) || "";
      }

      if (getIsAnimated(this.editor, asset.id)) {
        const { promise } = getFirstFrameOfAnimatedImage(src);
        src = await promise;
      }
      return src;
    });

    if (!src) return null;

    return <SvgImage shape={shape} src={src} />;
  }

  override onDoubleClickEdge(shape: ThemeImageShape) {
    if (this.editor.getCroppingShapeId() !== shape.id) {
      return;
    }

    const isDarkMode = this.editor.user.getIsDarkMode();

    const themeProps = getThemeProps(shape, isDarkMode);
    if (!themeProps) {
      return;
    }

    const crop = structuredClone(themeProps.crop) || {
      topLeft: { x: 0, y: 0 },
      bottomRight: { x: 1, y: 1 },
    };

    const { w, h } = getUncroppedSize(themeProps.dimension, crop);

    const pointDelta = new Vec(crop.topLeft.x * w, crop.topLeft.y * h).rot(
      shape.rotation,
    );

    const partial: TLShapePartial<ThemeImageShape> = {
      id: shape.id,
      type: shape.type,
      x: shape.x - pointDelta.x,
      y: shape.y - pointDelta.y,
      props: {
        ...setThemeProps(shape, isDarkMode, {
          w,
          h,
          crop: {
            topLeft: { x: 0, y: 0 },
            bottomRight: { x: 1, y: 1 },
          },
        }),
      },
    };

    this.editor.updateShapes([partial]);
  }

  override getInterpolatedProps(
    startShape: ThemeImageShape,
    endShape: ThemeImageShape,
    t: number,
  ): ThemeImageShapeProps {
    function interpolateCrop(
      startShape: ThemeImageShape,
      endShape: ThemeImageShape,
    ): ThemeImageShapeProps["crop"] {
      if (startShape.props.crop === null && endShape.props.crop === null) {
        return null;
      }

      const startTL = startShape.props.crop?.topLeft || { x: 0, y: 0 };
      const startBR = startShape.props.crop?.bottomRight || { x: 1, y: 1 };
      const endTL = endShape.props.crop?.topLeft || { x: 0, y: 0 };
      const endBR = endShape.props.crop?.bottomRight || { x: 1, y: 1 };

      return {
        topLeft: {
          x: lerp(startTL.x, endTL.x, t),
          y: lerp(startTL.y, endTL.y, t),
        },
        bottomRight: {
          x: lerp(startBR.x, endBR.x, t),
          y: lerp(startBR.y, endBR.y, t),
        },
        isCircle:
          startShape.props.crop?.isCircle ??
          endShape.props.crop?.isCircle ??
          false,
      };
    }

    return {
      ...(t > 0.5 ? endShape.props : startShape.props),
      w: lerp(startShape.props.w, endShape.props.w, t),
      h: lerp(startShape.props.h, endShape.props.h, t),
      crop: interpolateCrop(startShape, endShape),
    };
  }
}

async function getDataURIFromURL(url: string): Promise<string> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `Failed to fetch resource: ${response.status} ${response.statusText}`,
      );
    }
    const blob = await response.blob();
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = () =>
        reject(new Error("Failed to read blob as data URL"));
      reader.readAsDataURL(blob);
    });
  } catch (error) {
    // Optionally, you can log the error here
    throw new Error(`Error in getDataURIFromURL: ${(error as Error).message}`);
  }
}

// eslint-disable-next-line react-refresh/only-export-components
const ThemeImage = memo(function ThemeImage({
  shape,
}: {
  shape: ThemeImageShape;
}) {
  const editor = useEditor();
  const isDarkMode = useIsDarkMode();

  const { w } = getUncroppedSize(shape.props, shape.props.crop);

  // Pre-load both assets to avoid delay when switching themes
  const { asset: lightAsset, url: lightAssetUrl } = useImageOrVideoAsset({
    shapeId: shape.id,
    assetId: shape.props.assetIdLight,
    width: w,
  });
  const { asset: darkAsset, url: darkAssetUrl } = useImageOrVideoAsset({
    shapeId: shape.id,
    assetId: shape.props.assetIdDark,
    width: w,
  });

  const colorMode = resolveModeFallback(shape, isDarkMode);

  const asset =
    colorMode === "dark"
      ? darkAsset
      : colorMode === "light"
        ? lightAsset
        : null;
  const url =
    colorMode === "dark"
      ? darkAssetUrl
      : colorMode === "light"
        ? lightAssetUrl
        : null;

  // Sync per-theme width, height, and crop -> shape props.
  useEffect(() => {
    if (colorMode == null) {
      return;
    }
    const dimension =
      colorMode === "dark"
        ? shape.props.dimensionDark
        : shape.props.dimensionLight;
    const crop =
      colorMode === "dark" ? shape.props.cropDark : shape.props.cropLight;
    // Only update if values actually differ
    const currentW = shape.props.w;
    const currentH = shape.props.h;
    const currentCrop = shape.props.crop;

    const cropIsEqual =
      currentCrop === crop ||
      (currentCrop &&
        crop &&
        Object.keys(crop).length === Object.keys(currentCrop).length &&
        Object.keys(crop).every(
          (key) =>
            crop[key as keyof typeof crop] ===
            currentCrop[key as keyof typeof currentCrop],
        ));

    if (currentW !== dimension.w || currentH !== dimension.h || !cropIsEqual) {
      editor.updateShape({
        id: shape.id,
        type: shape.type,
        props: {
          w: dimension.w,
          h: dimension.h,
          crop,
        },
      });
    }
  }, [editor, shape, colorMode]);

  const prefersReducedMotion = usePrefersReducedMotion();
  const [staticFrameSrc, setStaticFrameSrc] = useState("");
  const [loadedUrl, setLoadedUrl] = useState<null | string>(null);
  const isAnimated = asset && getIsAnimated(editor, asset.id);

  useEffect(() => {
    if (url && isAnimated) {
      const { promise, cancel } = getFirstFrameOfAnimatedImage(url);

      promise.then((dataUrl) => {
        setStaticFrameSrc(dataUrl);
        setLoadedUrl(url);
      });

      return () => {
        cancel();
      };
    }
    return undefined;
  }, [editor, isAnimated, prefersReducedMotion, url]);

  const showCropPreview = useValue(
    "show crop preview",
    () =>
      shape.id === editor.getOnlySelectedShapeId() &&
      editor.getCroppingShapeId() === shape.id &&
      editor.isIn("select.crop"),
    [editor, shape.id],
  );

  const reduceMotion =
    prefersReducedMotion &&
    (asset?.props.mimeType?.includes("video") || isAnimated);

  const containerStyle = getCroppedContainerStyle(shape);

  const nextSrc = url === loadedUrl ? null : url;
  const loadedSrc = reduceMotion ? staticFrameSrc : loadedUrl;

  if (!url && !asset?.props.src) {
    return (
      <HTMLContainer
        id={shape.id}
        style={{
          overflow: "hidden",
          width: shape.props.w,
          height: shape.props.h,
          color: "var(--color-text-3)",
          backgroundColor: "var(--color-low)",
          border: "1px solid var(--color-low-border)",
        }}
      >
        <div
          className={classNames(
            "tl-image-container",
            asset && "tl-image-container-loading",
          )}
          style={containerStyle}
        >
          {asset ? null : <BrokenAssetIcon />}
        </div>
        {"url" in shape.props && shape.props.url && (
          <HyperlinkButton url={shape.props.url} />
        )}
      </HTMLContainer>
    );
  }

  const crossOrigin = isAnimated ? "anonymous" : undefined;

  return (
    <>
      {showCropPreview && loadedSrc && (
        <div style={containerStyle}>
          <img
            className="tl-image"
            style={{ ...getFlipStyle(shape), opacity: 0.1 }}
            crossOrigin={crossOrigin}
            src={loadedSrc}
            referrerPolicy="strict-origin-when-cross-origin"
            draggable={false}
            alt="crop preview"
          />
        </div>
      )}
      <HTMLContainer
        id={shape.id}
        style={{
          overflow: "hidden",
          width: shape.props.w,
          height: shape.props.h,
          borderRadius: shape.props.crop?.isCircle ? "50%" : undefined,
        }}
      >
        <div
          className={classNames("tl-image-container")}
          style={containerStyle}
        >
          {loadedSrc && (
            <img
              key={loadedSrc}
              className="tl-image"
              style={getFlipStyle(shape)}
              crossOrigin={crossOrigin}
              src={loadedSrc}
              referrerPolicy="strict-origin-when-cross-origin"
              draggable={false}
              alt={shape.props.altText}
            />
          )}
          {nextSrc && (
            <img
              key={nextSrc}
              className="tl-image"
              style={getFlipStyle(shape)}
              crossOrigin={crossOrigin}
              src={nextSrc}
              referrerPolicy="strict-origin-when-cross-origin"
              draggable={false}
              alt={shape.props.altText}
              onLoad={() => setLoadedUrl(nextSrc)}
            />
          )}
        </div>
        {shape.props.url && <HyperlinkButton url={shape.props.url} />}
      </HTMLContainer>
    </>
  );
});

function getIsAnimated(editor: Editor, assetId: TLAssetId) {
  const asset = editor.getAsset(assetId);

  if (!asset) return false;

  return (
    ("mimeType" in asset.props &&
      MediaHelpers.isAnimatedImageType(asset?.props.mimeType)) ||
    ("isAnimated" in asset.props && asset.props.isAnimated)
  );
}

function getCroppedContainerStyle(shape: ThemeImageShape) {
  const crop = shape.props.crop;
  const topLeft = crop?.topLeft;
  if (!topLeft) {
    return {
      width: shape.props.w,
      height: shape.props.h,
    };
  }

  const { w, h } = getUncroppedSize(shape.props, crop);
  const offsetX = -topLeft.x * w;
  const offsetY = -topLeft.y * h;
  return {
    transform: `translate(${offsetX}px, ${offsetY}px)`,
    width: w,
    height: h,
  };
}

function getFlipStyle(
  shape: ThemeImageShape,
  size?: { width: number; height: number },
) {
  const { flipX, flipY, crop } = shape.props;
  if (!flipX && !flipY) return undefined;

  let cropOffsetX;
  let cropOffsetY;
  if (crop) {
    const { w, h } = getUncroppedSize(shape.props, crop);

    const cropWidth = crop.bottomRight.x - crop.topLeft.x;
    const cropHeight = crop.bottomRight.y - crop.topLeft.y;

    cropOffsetX = modulate(
      crop.topLeft.x,
      [0, 1 - cropWidth],
      [0, w - shape.props.w],
    );
    cropOffsetY = modulate(
      crop.topLeft.y,
      [0, 1 - cropHeight],
      [0, h - shape.props.h],
    );
  }

  const scale = `scale(${flipX ? -1 : 1}, ${flipY ? -1 : 1})`;
  const translate = size
    ? `translate(${(flipX ? size.width : 0) - (cropOffsetX ? cropOffsetX : 0)}px,
             ${(flipY ? size.height : 0) - (cropOffsetY ? cropOffsetY : 0)}px)`
    : "";

  return {
    transform: `${translate} ${scale}`,
    transformOrigin: size ? "0 0" : "center center",
  };
}

// eslint-disable-next-line react-refresh/only-export-components
function SvgImage({ shape, src }: { shape: ThemeImageShape; src: string }) {
  const cropClipId = useUniqueSafeId();
  const containerStyle = getCroppedContainerStyle(shape);
  const crop = shape.props.crop;

  if (containerStyle.transform && crop) {
    const { transform: cropTransform, width, height } = containerStyle;
    const croppedWidth = (crop.bottomRight.x - crop.topLeft.x) * width;
    const croppedHeight = (crop.bottomRight.y - crop.topLeft.y) * height;

    const points = [
      new Vec(0, 0),
      new Vec(croppedWidth, 0),
      new Vec(croppedWidth, croppedHeight),
      new Vec(0, croppedHeight),
    ];

    const flip = getFlipStyle(shape, { width, height });

    return (
      <>
        <defs>
          <clipPath id={cropClipId}>
            {crop.isCircle ? (
              <ellipse
                cx={croppedWidth / 2}
                cy={croppedHeight / 2}
                rx={croppedWidth / 2}
                ry={croppedHeight / 2}
              />
            ) : (
              <polygon points={points.map((p) => `${p.x},${p.y}`).join(" ")} />
            )}
          </clipPath>
        </defs>
        <g clipPath={`url(#${cropClipId})`}>
          <image
            href={src}
            width={width}
            height={height}
            aria-label={shape.props.altText}
            style={flip ? { ...flip } : { transform: cropTransform }}
          />
        </g>
      </>
    );
  } else {
    return (
      <image
        href={src}
        width={shape.props.w}
        height={shape.props.h}
        aria-label={shape.props.altText}
        style={getFlipStyle(shape, {
          width: shape.props.w,
          height: shape.props.h,
        })}
      />
    );
  }
}

// eslint-disable-next-line react-refresh/only-export-components
function BrokenAssetIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 30 30"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3,11 L3,3 11,3" strokeWidth="2" />
      <path d="M19,27 L27,27 L27,19" strokeWidth="2" />
      <path d="M27,3 L3,27" strokeWidth="2" />
    </svg>
  );
}

const LINK_ICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='30' height='30' fill='none'%3E%3Cpath stroke='%23000' stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M13 5H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6M19 5h6m0 0v6m0-6L13 17'/%3E%3C/svg%3E";

// eslint-disable-next-line react-refresh/only-export-components
function HyperlinkButton({ url }: { url: string }) {
  const editor = useEditor();
  const hideButton = useValue("zoomLevel", () => editor.getZoomLevel() < 0.32, [
    editor,
  ]);
  const handlePointer: PointerEventHandler = useCallback(
    (e) => {
      if (!editor.inputs.shiftKey) stopEventPropagation(e);
    },
    [editor],
  );
  return (
    <a
      className={classNames("tl-hyperlink-button", {
        "tl-hyperlink-button__hidden": hideButton,
      })}
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onPointerDown={handlePointer}
      onPointerUp={handlePointer}
      title={url}
      draggable={false}
    >
      <div
        className="tl-hyperlink__icon"
        style={{
          mask: `url("${LINK_ICON}") center 100% / 100% no-repeat`,
          WebkitMask: `url("${LINK_ICON}") center 100% / 100% no-repeat`,
        }}
      />
    </a>
  );
}

function getFirstFrameOfAnimatedImage(url: string) {
  let cancelled = false;

  const promise = new Promise<string>((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      if (cancelled) return;

      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;

      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject("Could not get canvas context");
        return;
      }

      ctx.drawImage(image, 0, 0);
      resolve(canvas.toDataURL());
    };
    image.crossOrigin = "anonymous";
    image.src = url;
  });

  return { promise, cancel: () => (cancelled = true) };
}
