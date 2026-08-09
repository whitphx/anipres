import { BindingUtil } from "tldraw";
import type {
  BindingOnCreateOptions,
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
    return {};
  }

  override onAfterCreate({
    binding,
  }: BindingOnCreateOptions<MediaControlBinding>): void {
    // A marker bound after being positioned elsewhere (the timeline's
    // group-clone path copies a marker at the clone offset, then binds
    // it) would otherwise keep that position until its video next
    // moves.
    this.parkMarker(binding);
  }

  override onAfterChangeToShape({
    binding,
  }: BindingOnShapeChangeOptions<MediaControlBinding>): void {
    this.parkMarker(binding);
  }

  override onAfterChangeFromShape({
    binding,
  }: BindingOnShapeChangeOptions<MediaControlBinding>): void {
    // The marker itself can still be moved without being visible: the
    // event-strip badge selects it, and selection-wide operations
    // (arrow-key nudge, align) do not filter hidden shapes.
    this.parkMarker(binding);
  }

  // The marker is never rendered, but hidden shapes still count toward
  // page bounds (`zoomToFit` does not filter them), so a marker with a
  // stale position would skew camera fitting. Keep it parked at the
  // video's page origin. Parent-space conversion because the marker is
  // not guaranteed to be a page child (select-all can sweep it into a
  // group); the no-op-when-equal check terminates the change→park
  // cycle.
  private parkMarker(binding: MediaControlBinding): void {
    const marker = this.editor.getShape(binding.fromId);
    const videoBounds = this.editor.getShapePageBounds(binding.toId);
    if (marker == null || videoBounds == null) {
      return;
    }
    const point = this.editor.getPointInParentSpace(marker, {
      x: videoBounds.x,
      y: videoBounds.y,
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
