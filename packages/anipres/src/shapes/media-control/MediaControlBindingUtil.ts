import { BindingUtil } from "tldraw";
import {
  MediaControlBindingType,
  mediaControlBindingProps,
  type MediaControlBinding,
} from "./MediaControlBinding";

/**
 * The util no longer carries lifecycle callbacks: nothing about this
 * binding decides what a media event controls any more, since an event
 * names its video through the `videoKey` in its own frame, which is
 * remapped on copy the way `trackId` already is and is what a video of
 * several carriers needs — a binding to one keyframe would cascade that
 * keyframe's deletion onto the whole video's events.
 *
 * The binding itself is still written, by `writeLegacyMediaControlBinding`,
 * and repointed as carriers come and go by the video lifecycle. That is
 * for an older build's sake, which resolves an event only through the
 * binding and deletes a marker that has none. Do not take the missing
 * callbacks here for a dead record type.
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
