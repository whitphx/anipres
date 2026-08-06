import { BindingUtil } from "tldraw";
import type {
  BindingOnShapeChangeOptions,
  BindingOnShapeDeleteOptions,
} from "tldraw";
import {
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
    // Markers are page children, so page space is their parent space.
    const x = videoBounds.x + binding.props.anchorX;
    const y = videoBounds.y + binding.props.anchorY;
    if (marker.x !== x || marker.y !== y) {
      this.editor.updateShape({ id: marker.id, type: marker.type, x, y });
    }
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
