import {
  TLBaseShape,
  SVGContainer,
  ShapeUtil,
  Geometry2d,
  Rectangle2d,
  useValue,
  getPerfectDashProps,
  TLResizeInfo,
  resizeBox,
  T,
  RecordProps,
} from "tldraw";

export const SlideShapeType = "slide" as const;

export type SlideShape = TLBaseShape<
  typeof SlideShapeType,
  { w: number; h: number }
>;

export class SlideShapeUtil extends ShapeUtil<SlideShape> {
  static override readonly type = SlideShapeType;
  static override props: RecordProps<SlideShape> = {
    w: T.number,
    h: T.number,
  };

  override canBind() {
    return false; // TODO: Be configurable?
  }
  override hideRotateHandle() {
    return true; // NOTE: Camera rotation is not supported, so hide the rotate handle on the slide shape.
  }

  getDefaultProps(): SlideShape["props"] {
    return {
      w: 720,
      h: 480,
    };
  }

  getGeometry(shape: SlideShape): Geometry2d {
    return new Rectangle2d({
      width: shape.props.w,
      height: shape.props.h,
      isFilled: false,
    });
  }

  override onResize(shape: SlideShape, info: TLResizeInfo<SlideShape>) {
    return resizeBox(shape, info);
  }

  component(shape: SlideShape) {
    const bounds = this.editor.getShapeGeometry(shape).bounds;

    // eslint-disable-next-line react-hooks/rules-of-hooks
    const zoomLevel = useValue("zoom level", () => this.editor.getZoomLevel(), [
      this.editor,
    ]);

    return (
      <SVGContainer>
        <g
          style={{
            stroke: "var(--color-text)",
            strokeWidth: "calc(1px * var(--tl-scale))",
            opacity: 0.25,
          }}
          pointerEvents="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {bounds.sides.map((side, i) => {
            const { strokeDasharray, strokeDashoffset } = getPerfectDashProps(
              side[0].dist(side[1]),
              1 / zoomLevel,
              {
                style: "dashed",
                lengthRatio: 6,
                forceSolid: zoomLevel < 0.2,
              },
            );

            return (
              <line
                key={i}
                x1={side[0].x}
                y1={side[0].y}
                x2={side[1].x}
                y2={side[1].y}
                strokeDasharray={strokeDasharray}
                strokeDashoffset={strokeDashoffset}
              />
            );
          })}
        </g>
      </SVGContainer>
    );
  }

  indicator(shape: SlideShape) {
    return <rect width={shape.props.w} height={shape.props.h} />;
  }
}
