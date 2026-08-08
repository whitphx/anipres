import { Rectangle2d, ShapeUtil } from "tldraw";
import type { Geometry2d } from "tldraw";
import {
  MediaControlShape,
  MediaControlShapeType,
  mediaControlShapeProps,
} from "./MediaControlShape";

export class MediaControlShapeUtil extends ShapeUtil<MediaControlShape> {
  static override readonly type = MediaControlShapeType;
  static override readonly props = mediaControlShapeProps;

  override getDefaultProps(): MediaControlShape["props"] {
    return {};
  }

  // Zero-size geometry: markers are metadata carriers, not canvas
  // objects, so they must expose no hit-test area. Rendering and
  // interaction are additionally excluded wholesale by
  // `getShapeVisibility` in Anipres returning "hidden" for this type;
  // the empty component/indicator below are the shape's own statement
  // of the same fact.
  override getGeometry(): Geometry2d {
    return new Rectangle2d({
      width: 0,
      height: 0,
      isFilled: false,
    });
  }

  component() {
    return null;
  }

  indicator() {
    return null;
  }
}
