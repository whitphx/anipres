/**
 * The version a client declares to the sync server, and the one the
 * server requires (see `REQUIRED_SYNC_ANIMATION_DATA_VERSION` in the
 * worker). Distinct from `TIMELINE_FORMAT_VERSION`
 * (`timeline-model/types.ts`), which describes the shape of a frame's
 * `meta` and is unchanged by a new action type.
 *
 * Bump this whenever a build starts persisting records an older build
 * cannot safely handle — tldraw's store schema versioning covers custom
 * shape PROPS, not the existence of a shape/binding type or the
 * vocabulary inside `meta` (spec: docs/design-animation-data-model.md,
 * Risk 6). Both failure modes are silent-to-destructive rather than
 * loud: an unknown record type fails the store load outright, and an
 * unknown frame action parses as an `invalid-frame` diagnostic whose
 * offered repair CLEARS the frame, discarding the newer build's data.
 *
 * History:
 * - 2: animation data model v2 (the ordering rewrite this gate was
 *   introduced for).
 * - 3: the `mediaControl` frame action plus the `youtube-embed` and
 *   `media-control` shapes and the `media-control` binding.
 * - 4: video identity — a `mediaControl` action names its target with
 *   a `videoKey`, and the `media-control` binding that used to carry
 *   it is gone, its type no longer registered. The new vocabulary is
 *   all in `meta`, which a version-3 client ignores, but it knows
 *   nothing of one video spread across carriers and would mount a
 *   player per carrier; and a version-3 document still holds bindings
 *   this build cannot validate, so it fails to load rather than
 *   degrading. Neither side may open the other's documents, which is
 *   what the gate enforces. Version 3 shipped in no release: both
 *   changesets are pending together, so no published version has
 *   written either vocabulary.
 *
 * The server gate matches this value exactly. In the deployment this
 * repo ships, the worker serves the app bundle, so both sides move
 * together and only a tab still running the previous bundle is locked
 * out — until it reloads. A deployment that ships them separately
 * would need the worker first for a bump that adds record types, since
 * it is the side that has to store them.
 */
export const SYNC_CLIENT_VERSION = 4;
