import { BindingUtil } from "tldraw";
import {
  MediaControlBindingType,
  mediaControlBindingProps,
  type MediaControlBinding,
} from "./MediaControlBinding";

/**
 * No lifecycle callbacks, because nothing about this binding decides
 * anything any more: an event names its video through the `videoKey` in
 * its own frame.
 *
 * The util survives because on the client it *is* the schema
 * registration: the `bindingUtils` array is what the store's schema is
 * built from, so removing it would make an unconverted document fail
 * validation instead of loading long enough for
 * `convertLegacyVideoIdentity` to read the binding and drop it.
 */
export class MediaControlBindingUtil extends BindingUtil<MediaControlBinding> {
  static override readonly type = MediaControlBindingType;
  static override readonly props = mediaControlBindingProps;

  override getDefaultProps(): MediaControlBinding["props"] {
    return {};
  }
}
