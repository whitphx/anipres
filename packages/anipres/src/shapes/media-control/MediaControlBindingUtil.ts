import { BindingUtil } from "tldraw";
import {
  MediaControlBindingType,
  mediaControlBindingProps,
  type MediaControlBinding,
} from "./MediaControlBinding";

/**
 * Inert. Nothing writes this binding any more — a media event names its
 * video through the `videoKey` in its own frame, which is both remapped
 * on copy the way `trackId` already is and correct for a video that is
 * several carriers, where a binding to one keyframe would cascade its
 * deletion onto the whole video's events.
 *
 * The util survives because on the client it *is* the schema
 * registration: the `bindingUtils` array is what the store's schema is
 * built from, so removing it would make a document that still holds the
 * binding fail validation instead of loading long enough for
 * `normalizeVideoIdentity` to rewrite it.
 */
export class MediaControlBindingUtil extends BindingUtil<MediaControlBinding> {
  static override readonly type = MediaControlBindingType;
  static override readonly props = mediaControlBindingProps;

  override getDefaultProps(): MediaControlBinding["props"] {
    return {};
  }
}
