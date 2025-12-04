import {
  BaseBoxShapeUtil,
  Editor,
  Ellipse2d,
  FileHelpers,
  Geometry2d,
  HTMLContainer,
  MediaHelpers,
  Rectangle2d,
  SvgExportContext,
  TLAsset,
  TLAssetId,
  TLBaseShape,
  TLImageShapeProps,
  TLResizeInfo,
  TLShapePartial,
  RecordProps,
  T,
  Vec,
  WeakCache,
  imageShapeProps,
  lerp,
  modulate,
  resizeBox,
  structuredClone,
  toDomPrecision,
  useEditor,
  useUniqueSafeId,
  useValue,
  useImageOrVideoAsset,
  usePrefersReducedMotion,
} from "tldraw";
import classNames from "classnames";
import { memo, useEffect, useState } from "react";
import { getUncroppedSize } from "tldraw";

export const ThemeImageShapeType = "themeImage" as const;

export type ThemeImageShapeProps = TLImageShapeProps & {
  darkAssetId: TLAssetId | null;
  darkUrl: string;
};

export type ThemeImageShape = TLBaseShape<
  typeof ThemeImageShapeType,
  ThemeImageShapeProps
>;

const darkModeImageShapeProps: RecordProps<ThemeImageShape> = {
  ...imageShapeProps,
  darkAssetId: imageShapeProps.assetId,
  darkUrl: T.linkUrl,
};

const darkModeImageSvgExportCache = new WeakCache<
  TLAsset,
  Promise<string | null>
>();

export class ThemeImageShapeUtil extends BaseBoxShapeUtil<ThemeImageShape> {
  static override type = ThemeImageShapeType;
  static override props = darkModeImageShapeProps;

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
      assetId: null,
      darkAssetId: null,
      darkUrl: "",
      url: "",
      crop: null,
      flipX: false,
      flipY: false,
      playing: true,
      altText: "",
    } as ThemeImageShapeProps;
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
    let resized: ThemeImageShape = resizeBox(shape, info);
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
    const preferredAssetId = ctx.isDarkMode
      ? (props.darkAssetId ?? props.assetId)
      : (props.assetId ?? props.darkAssetId);
    if (!preferredAssetId) return null;

    const asset = this.editor.getAsset(preferredAssetId);
    if (!asset) return null;

    const { w } = getUncroppedSize(shape.props, props.crop);

    const src = await darkModeImageSvgExportCache.get(asset, async () => {
      let resolvedSrc = await ctx.resolveAssetUrl(asset.id, w);
      if (!resolvedSrc) return null;
      if (
        resolvedSrc.startsWith("blob:") ||
        resolvedSrc.startsWith("http") ||
        resolvedSrc.startsWith("/") ||
        resolvedSrc.startsWith("./")
      ) {
        resolvedSrc = (await getDataURIFromURL(resolvedSrc)) || "";
      }

      if (getIsAnimated(this.editor, asset.id)) {
        const { promise } = getFirstFrameOfAnimatedImage(resolvedSrc);
        resolvedSrc = await promise;
      }
      return resolvedSrc;
    });

    if (!src) return null;

    return <SvgImage shape={shape} src={src} />;
  }

  override onDoubleClickEdge(shape: ThemeImageShape) {
    const props = shape.props;
    if (!props) return;

    if (this.editor.getCroppingShapeId() !== shape.id) {
      return;
    }

    const crop = structuredClone(props.crop) || {
      topLeft: { x: 0, y: 0 },
      bottomRight: { x: 1, y: 1 },
    };

    const { w, h } = getUncroppedSize(shape.props, crop);

    const pointDelta = new Vec(crop.topLeft.x * w, crop.topLeft.y * h).rot(
      shape.rotation,
    );

    const partial: TLShapePartial<ThemeImageShape> = {
      id: shape.id,
      type: shape.type,
      x: shape.x - pointDelta.x,
      y: shape.y - pointDelta.y,
      props: {
        crop: {
          topLeft: { x: 0, y: 0 },
          bottomRight: { x: 1, y: 1 },
        },
        w,
        h,
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

const ThemeImage = memo(function ThemeImage({
  shape,
}: {
  shape: ThemeImageShape;
}) {
  const editor = useEditor();

  const { w } = getUncroppedSize(shape.props, shape.props.crop);
  const prefersDarkMode = useValue(
    "prefers dark",
    () => editor.user.getIsDarkMode(),
    [editor],
  );
  const { asset: lightAsset, url: lightAssetUrl } = useImageOrVideoAsset({
    shapeId: shape.id,
    assetId: shape.props.assetId,
    width: w,
  });
  const { asset: darkAsset, url: darkAssetUrl } = useImageOrVideoAsset({
    shapeId: shape.id,
    assetId: shape.props.darkAssetId,
    width: w,
  });

  const activeAsset =
    (prefersDarkMode ? darkAsset : lightAsset) ?? lightAsset ?? darkAsset;
  const activeUrl =
    (prefersDarkMode ? darkAssetUrl : lightAssetUrl) ??
    lightAssetUrl ??
    darkAssetUrl;
  const hyperlinkUrl =
    (prefersDarkMode && shape.props.darkUrl) || shape.props.url;

  const prefersReducedMotion = usePrefersReducedMotion();
  const [staticFrameSrc, setStaticFrameSrc] = useState("");
  const [loadedUrl, setLoadedUrl] = useState<null | string>(null);
  const isAnimated =
    activeAsset != null && getIsAnimated(editor, activeAsset.id);

  useEffect(() => {
    if (activeUrl && isAnimated) {
      const { promise, cancel } = getFirstFrameOfAnimatedImage(activeUrl);

      promise.then((dataUrl) => {
        setStaticFrameSrc(dataUrl);
        setLoadedUrl(activeUrl);
      });

      return () => {
        cancel();
      };
    }
  }, [editor, isAnimated, prefersReducedMotion, activeUrl]);

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
    (activeAsset?.props.mimeType?.includes("video") ||
      ("isAnimated" in (activeAsset?.props ?? {}) &&
        activeAsset?.props.isAnimated));

  const containerStyle = getCroppedContainerStyle(shape);

  const nextSrc = activeUrl === loadedUrl ? null : activeUrl;
  const loadedSrc = reduceMotion ? staticFrameSrc : loadedUrl;

  useEffect(() => {
    if (!activeAsset) {
      return;
    }
    const targetAspect = activeAsset.props.w / activeAsset.props.h;
    if (!Number.isFinite(targetAspect) || targetAspect <= 0) {
      return;
    }
    const currentAspect = shape.props.w / shape.props.h;
    if (Math.abs(targetAspect - currentAspect) < 0.001) {
      return;
    }
    const area = shape.props.w * shape.props.h;
    const nextW = Math.sqrt(area * targetAspect);
    const nextH = nextW / targetAspect;
    editor.updateShapes([
      {
        id: shape.id,
        type: shape.type,
        props: { w: nextW, h: nextH, crop: null },
      },
    ]);
  }, [activeAsset, editor, shape.id, shape.props.h, shape.props.w]);

  if (!activeUrl && !activeAsset?.props.src) {
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
            activeAsset && "tl-image-container-loading",
          )}
          style={containerStyle}
        >
          {activeAsset ? null : <div>Missing image</div>}
        </div>
        {hyperlinkUrl && (
          <a
            href={hyperlinkUrl}
            target="_blank"
            rel="noreferrer"
            style={{ position: "absolute", right: 8, bottom: 8 }}
          >
            Open link
          </a>
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
            alt=""
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
              alt=""
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
        {hyperlinkUrl && (
          <a
            href={hyperlinkUrl}
            target="_blank"
            rel="noreferrer"
            style={{ position: "absolute", right: 8, bottom: 8 }}
          >
            Open link
          </a>
        )}
      </HTMLContainer>
    </>
  );
});

function getIsAnimated(editor: Editor, assetId: TLAssetId) {
  const asset = assetId ? editor.getAsset(assetId) : undefined;

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

function getFirstFrameOfAnimatedImage(url: string) {
  let cancelled = false;

  const promise = new Promise<string>((resolve) => {
    const image = new Image();
    image.onload = () => {
      if (cancelled) return;

      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;

      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      ctx.drawImage(image, 0, 0);
      resolve(canvas.toDataURL());
    };
    image.crossOrigin = "anonymous";
    image.src = url;
  });

  return { promise, cancel: () => (cancelled = true) };
}

async function getDataURIFromURL(url: string): Promise<string> {
  const response = await fetch(url);
  const blob = await response.blob();
  return FileHelpers.blobToDataUrl(blob);
}
