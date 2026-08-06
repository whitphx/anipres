import { BindingUtil } from "tldraw";
import type {
  BindingOnShapeChangeOptions,
  BindingOnShapeDeleteOptions,
} from "tldraw";
import {
  getMediaControlMarkerAnchor,
  MediaControlBindingType,
  mediaControlBindingProps,
  type MediaControlBinding,
} from "./MediaControlBinding";

export class MediaControlBindingUtil extends BindingUtil<MediaControlBinding> {
  static override readonly type = MediaControlBindingType;
  static override readonly props = mediaControlBindingProps;

  override getDefaultProps(): MediaControlBinding["props"] {
    return { anchorX: 0, anchorY: 0 };
  }

  override onAfterChangeToShape({
    binding,
  }: BindingOnShapeChangeOptions<MediaControlBinding>): void {
    const marker = this.editor.getShape(binding.fromId);
    const videoBounds = this.editor.getShapePageBounds(binding.toId);
    if (marker == null || videoBounds == null) {
      return;
    }
    // The anchor is page-space; the marker's x/y are parent-space and
    // the marker may not be a page child (e.g. grouped by the user).
    const point = this.editor.getPointInParentSpace(marker, {
      x: videoBounds.x + binding.props.anchorX,
      y: videoBounds.y + binding.props.anchorY,
    });
    if (marker.x !== point.x || marker.y !== point.y) {
      this.editor.updateShape({
        id: marker.id,
        type: marker.type,
        x: point.x,
        y: point.y,
      });
    }
  }

  override onAfterChangeFromShape({
    binding,
  }: BindingOnShapeChangeOptions<MediaControlBinding>): void {
    // The marker moved — dragged, nudged, aligned, or repositioned by
    // the hook above. Record its current offset so the next video
    // change keeps it; when the offset is unchanged (as after a
    // reposition), this is a no-op, which is what terminates the
    // reposition → re-anchor cycle.
    const props = getMediaControlMarkerAnchor(
      this.editor,
      binding.fromId,
      binding.toId,
    );
    if (
      props == null ||
      (props.anchorX === binding.props.anchorX &&
        props.anchorY === binding.props.anchorY)
    ) {
      return;
    }
    this.editor.updateBinding<MediaControlBinding>({ ...binding, props });
  }

  override onBeforeDeleteToShape({
    binding,
  }: BindingOnShapeDeleteOptions<MediaControlBinding>): void {
    // The marker exists only to carry an event for its video; deleting
    // the video deletes its markers (and their timeline frames with
    // them).
    const marker = this.editor.getShape(binding.fromId);
    if (marker != null) {
      this.editor.deleteShape(marker.id);
    }
  }
}
