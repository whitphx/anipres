# Moving and resizing a video during a presentation

Status: proposed.

## Goal

Let a video change position and size across presentation steps, the way
any other shape does — and, in doing so, replace the workaround that
made videos a special case in the first place. Playback stays smooth
across the move: the same player keeps playing, at the same position in
the video, while its frame travels.

A video _shape_ does not need to be a player. That relaxation is what
makes the rest of this design possible, and it is the one thing the
reader should carry into every section below. Editing keeps a live,
interactive player — just one per video, owned by the runtime rather
than by any shape.

## Why the current shape of the feature exists

The v2 animation model expresses "this shape is here at step 2, and
there at step 5" by carrying each keyframe on a **copy** of the shape.
Navigation switches which copy is visible, and a temporary clone tweens
between them.

For a video that mechanism is unusable: a copy is a second
`youtube-embed`, and a mounted `youtube-embed` is a live iframe. Two
copies means two players competing for the same video, and switching
visibility between them at a step boundary would restart playback
exactly when it should continue.

Everything that currently makes videos special descends from that one
fact — the `media-control` marker shape (a frame carrier that is _not_
a copy of the video), the `media-control` binding that ties it back,
the withheld follow-up-frame buttons, and the video's exemption from
the latest-frame-of-batch visibility rule.

## The idea

**Stop mounting a player per shape.** Video shapes render a static
poster; exactly one live player exists per video, owned by the runtime,
positioned to follow whichever shape currently represents that video —
in presentation mode and while editing alike.

Once a video shape is no longer a player, a copy of it is harmless, and
the special case collapses:

- Keyframes become **ordinary copies**, like every other animated
  shape. Drag & drop, the follow-up-frame buttons, duplicate-remap and
  paste all apply unchanged, with no new authoring UI to build.
- The player never remounts, because it is never owned by a shape that
  can be hidden, replaced or re-created. The class of bug that produced
  the reconnect and re-render remounts cannot recur here.
- The video's exemption from the visibility rule goes away: with real
  copies on the track, the latest-frame-of-batch rule is correct again.

### Where the player lives

`components.OnTheCanvas` renders inside `tl-html-layer tl-shapes`, the
element that carries the camera transform (`InFrontOfTheCanvas` is
outside it). A player placed there is positioned in page coordinates
and inherits pan, zoom and `cameraZoom` animation for free — the same
way a shape does, and without the store learning anything about it.

The camera is all the layer provides; the rest of the carrier's
rendering context is mirrored explicitly. tldraw styles each shape's
container from the same small set of computed values — the full page
transform (`getShapePageTransform`, so ancestor rotation and group
movement are included), the geometry bounds' width and height, the
clip path (`getShapeClipPath`, which is how frame masks apply), the
composed opacity, and a `z-index` that mirrors the shape's position in
the page's sorted shape order — the order the renderer itself is fed,
and one that is defined for every shape whether or not it is currently
rendered, so hiding a carrier does not unmoor the player's layering.
Shape containers are stacked as siblings by `z-index`, so a player
container subscribing to the same values of its anchor carrier sits in
the same stacking context: a video inside a frame is clipped by the
frame, a shape drawn above the video occludes the live player, and a
keyframe with a different size resizes the player — the iframe fills
its container, so the embedded player rescales with no API
involvement.

During a step tween the transform and the width/height interpolate
between the outgoing and incoming carriers' stored values, opacity and
`z-index` follow the incoming carrier, and the clip path is dropped
for the duration, the incoming carrier's mask applying when the tween
lands. Unclipped travel is not a compromise; it is what every other
animated shape already does — the tween clone is created as a
page-level shape, outside any frame's mask, and the destination mask
takes over only when the real carrier appears on arrival. A video
moving into, out of, or between frames behaves like any shape making
the same move.

Which carrier the player anchors to is explicit runtime state, never
derived from what happens to be rendered. Carrier visibility exists to
show posters; the player's placement cannot follow it, because during
an animated step there is no visible carrier at all — `runStep` hides
the incoming frame's carrier for the length of the tween, and the
outgoing one has stopped being current. The runtime moves the anchor
through three states:

- **Steady, presenting.** The anchor is the carrier the visibility
  rule shows, and the player mirrors its values.
- **Tweening.** Advancing a step re-points the anchor at the incoming
  carrier and interpolates transform and size from the outgoing
  carrier's stored geometry to the incoming one's. Both records are
  hidden while this runs; the runtime reads stored values, not
  rendered state, and the mirrored opacity is the carrier's own
  composition without the presentation hiding — the player _is_ the
  video's visible representation while its carriers are not.
  Cancelling, jumping, or navigating away mid-tween drops the anchor
  to the folded target directly, per the reconciliation rule below.
- **Editing.** Every carrier is visible, so a fixed rule takes over:
  the anchor is the carrier of the sequence's earliest keyframe — the
  video's starting position — and an unanimated video is its only
  carrier. Deleting or reordering keyframes re-evaluates the rule.
- **Absent.** Before a video's cue step, after a backward jump to a
  step before it, or once every carrier is gone, the fold yields no
  anchor at all. The player stays mounted — unmounting is the reload
  hazard — but is hidden and inert: `visibility: hidden`, no pointer
  events, playback paused. It leaves this state the moment the fold
  yields an anchor again, which is what re-advancing does. Absent is
  a rendering state, not an eviction; the lifecycle policy below
  decides separately whether a long-absent player is worth keeping
  mounted.

A change of anchor only changes which shape's values the player
mirrors, never the player's place in the DOM, so it cannot remount the
iframe — which is what made every re-anchoring scheme on shape-mounted
players unsafe.

Viewport culling is deliberately not mirrored — hiding a live player
because its carrier scrolled away is the remount hazard again — but
culling answers visibility, not cost. One player per video still
means a document with many videos could mount many iframes, so
mounting is bounded by a lifecycle policy instead: a video gets a live
player while it is presenting, playing, selected, or near the
viewport, and shows only its poster otherwise. Eviction records the
player's current position in runtime state and seeds the replacement
from it, so an evicted paused video resumes where it left off. A
playing video is never evicted for being off-screen — it may be
audible.

Keeping the store out of it is the reason not to animate the video
shape directly. Writing `x`/`y`/`w`/`h` during playback would put
presentation state into the document: on a synced deck every
intermediate frame broadcasts
to collaborators, an interrupted presentation leaves the video
displaced, and `bailToMark` — which is how the current animation code
suppresses history — would fight the animation. Runtime state belongs
where the desired playback state already lives: outside the document.

### What the runtime tracks

Per video, the runtime already holds a desired **playback** state
(playing/paused, muted, volume) folded from the event history. This
adds a desired **transform** — position, size and rotation — folded
the same way from the keyframe history:

- Advancing one step tweens the transform over the frame's `duration`
  with its `easing`, alongside the existing animation.
- A jump or a backward move reconciles it directly to the folded value,
  with no tween — the same rule `foldMediaPlaybackStates` follows, for
  the same reason.
- Leaving presentation mode clears it, like `pauseAll`.

## Identity: `videoKey`

A moving video is several shapes. Something has to say "these carriers
are one video", and media events have to name the video they act on.

`trackId` is the wrong answer. A track says _which animation sequence_
a keyframe belongs to; a video that is visible from the start and only
receives media events has no animation at all, and so no track, while
still being a perfectly valid subject for `play` and `pause`.

So the video carries its own identity: a **`videoKey` prop**, minted
when the video is placed.

- **`videoKey`** — which video instance this is. Keys the live player,
  and is what a media event targets.
- **`trackId`** — which animation sequence a keyframe belongs to.
  Present only when the video is animated.

Carriers of one video share both. An unframed video has a `videoKey`
and no track. The two questions stop being entangled.

The duplicate-vs-rejoin distinction comes for free: the
follow-up-keyframe path is ours and preserves `videoKey`, while
`Cmd+D` and paste run through the remap wrapper, which mints a fresh
one alongside the fresh `trackId`. Duplicating a video therefore yields
an independent video with its own player, which is what the gesture
implies.

### One video, one configuration

Sharing an identity means sharing a configuration. A carrier copy
carries all of the video's props, and `videoId`, `start`, `muted`,
`controls` and `altText` describe the video, not a keyframe — two
carriers of one `videoKey` disagreeing on `videoId` is incoherent. So
media props are held identical across a `videoKey`'s carriers by the
same kind of side effect that parks markers: editing them on one
carrier writes them to all, and only geometry may differ between
keyframes. The player then has exactly one configuration to read, from
whichever carrier is the anchor. New keyframes copy the props, so they
are born consistent; existing documents have one carrier per video, so
nothing already disagrees. Editing `videoId` still reloads the iframe
— changing which video this is is a different operation from moving
it, and the reload is the point.

### Existing documents

Existing videos predate the prop, so a migration materializes it:
`videoKey = shape.id`, which identifies each existing video as itself
— correct because today every video is exactly one shape, and
deterministic, as migrations must be (that constraint rules out
minting random keys, not writing the record's own id). The props-only
migration helper cannot express this, because its callback receives
the props value and never sees the record id — so the materialization
is a record-scoped shape migration, the kind whose callback receives
the whole record. Record-scoped migrations are also what tldraw
replays on each record of a pasted `TLContent` payload, so the key is
in place everywhere a legacy record can appear — store loads and
pastes alike — before any copy can be made, and travels with every
copy.

A read-time fallback would not be enough: a follow-up keyframe copied
from a video whose key was never stored would fall back to its _own_
new shape id, splitting one video into two identities the first time
it is animated. Materializing the key closes that hole.

## What this removes

Media events no longer need a record pointing at a shape. The binding
existed because tldraw remaps binding endpoints on copy/paste while a
shape id in props would go stale — but a `videoKey` in the frame's
action is remapped by the same operation-scoped machinery that already
handles `trackId`, so the guarantee survives without the record.

It also stops being _correct_ to bind to a shape: with several
carriers, a binding to keyframe #1 would cascade-delete a video's
events when that one keyframe is deleted.

Removed: `bindMediaControlMarker`, `copyMediaControlBinding`,
`getMediaControlBindingTargetId`, the marker parking hooks, and every
lifecycle hook on `MediaControlBindingUtil`. The util itself survives
as an inert shell, because on the client the util _is_ the schema
registration — the `bindingUtils` array is what the store's schema is
built from — and the worker keeps its explicit `createTLSchema` entry
for the same reason. Both stay so that documents already holding the
binding still validate long enough to be migrated; the Rollout section
says how.

Kept: the `media-control` marker shape. One frame per shape is still
the rule, so a media event still needs a carrier that is not the video.
`expandShapeIdsWithMediaControlMarkers` also stays, re-keyed to
`videoKey`, because copying a video should still bring its events along
and rewrite them to the copy's key.

### Delete and parking, without the binding

**Delete.** When a delete operation leaves a `videoKey` with no
carrier, its event markers are removed with it. The check runs once
against the store after the whole batch, inside the same history
entry — not per shape during the batch, where deleting every keyframe
of a video in one selection would let each removal see the others'
carriers as still present and conclude nothing was orphaned. Living
inside the history entry also means one undo restores markers and
carriers together. Deleting one keyframe of an animated video leaves
the events alone — which the binding's per-shape cascade would have
got wrong.

**Parking.** Markers are invisible and zero-size, but they still count
toward `getCurrentPageBounds`, so a marker left behind by a moved video
skews `zoomToFit`. Parking therefore follows the carrier's _page_
position: a reaction on the carrier's `getShapePageTransform` — not a
store side effect on the carrier record — keeps a video's markers at
its position, so movement that never touches the carrier itself
(dragging a parent group, resizing an enclosing frame, reparenting)
parks just as well as dragging the video does. The cheaper alternative
— park once at
creation and accept drift — is rejected: the drift is unbounded in the
one case users notice, which is moving a video far across the canvas.

## Editing

Video shapes render a static poster
(`i.ytimg.com/vi/<id>/hqdefault.jpg`), and the runtime anchors the one
live player to a single carrier of each `videoKey` — so a video is
still playable and interactive while editing, and the other keyframes
show where it will travel to. Nothing about a shape mounts a player, so
copies cost nothing.

Authoring a movement keyframe is then the same gesture as for any other
shape: extend the sequence from the timeline's follow-up-frame button,
then move or resize the new copy. No ghost outline, no bespoke
transform editor, no second kind of marker — the reason those were on
the table was that copies were forbidden.

`canExtendFrameSequenceFrom` drops its carrier-type exclusion for
videos; it keeps the action-type exclusion, since media events are
still added with "+ Media event" and chained by dragging.

## Alternatives considered

**Keyframe target on the marker's transform.** Markers carrying a
`shapeAnimation` frame become visible as a draggable ghost of the
video, and their transform is the target. Good authoring ergonomics
without touching the player architecture, but it needs the `w`/`h`
props back, makes parking and visibility conditional on the frame's
action type, and keeps every video a live player — so the remount
hazard and the withheld buttons stay. It buys movement without
simplifying anything.

**Keyframe target in the action's metadata.** Markers stay uniformly
invisible and no props change, but nothing on canvas represents the
target, so it needs a purpose-built overlay with its own drag and
resize handles: the most new UI of the three, reimplementing what
tldraw already gives a copy.

Both were shaped by the constraint that a copy of a video is
impossible. Removing that constraint is what makes them unnecessary.

**Mounting the player on one carrier shape.** Keeps live editing
without an overlay, by designating a single carrier as the host. Two
things break it. Culling is computed from a shape's own store bounds
and sets `display: none` on its container, so a player visually
displaced onto the screen is hidden whenever its host's home position
leaves the viewport. And re-anchoring — at a step boundary, when the
host is hidden by the visibility rule, or when it is deleted — moves
the iframe between DOM parents, which reloads it. Runtime ownership
avoids both while giving the same live editing.

**Multiple frames per shape.** Would remove the marker entirely, but
one-frame-per-shape is load-bearing across the derivation, the timeline
UI and reconciliation. Rejected for the same reason the media-event
array was rejected earlier: it trades one record type for a rewrite of
everything that reads frames.

## Rollout

The persisted vocabulary changes: the `mediaControl` action gains its
target key, `youtube-embed` gains `videoKey`, and the `media-control`
binding stops being written. `SYNC_CLIENT_VERSION` moves to 4, and old
clients are refused as usual.

Documents that already hold the binding are migrated on load, not
stranded. The version gate only refuses old *clients*; it does nothing
for the binding records that existing documents contain, and those
documents surface in more places than the sole-user framing suggests —
synced rooms, snapshot files, clipboard payloads, locally cached
copies. Whole documents arrive through tldraw's store migration path;
clipboard content does not, and gets its own pass:

- The binding type stays registered (see above), so the old records
  load instead of failing validation.
- The record-scoped shape migration materializes `videoKey` on every
  legacy video (see "Existing documents").
- A store-level migration resolves, for each `media-control` binding,
  the video shape at its `toId`, and writes that shape's id — now that
  video's materialized `videoKey` — into the `mediaControl` action
  carried by the marker at its `fromId`. The event keeps its target.
  The binding record itself stays, per the rollback rule below.
- Legacy stores can also hold degraded records — a marker that lost
  its binding, a binding whose endpoint is missing or of the wrong
  type — and today the mount path deletes unbound markers as its
  recovery. That recovery moves into the migration: a marker whose
  `mediaControl` action cannot be given a target — no binding, or a
  binding that does not resolve to a video — is deleted, along with
  any dangling binding. Deleting these is rollback-neutral, because
  the previous release's own cleanup does the same.
- The migration reads only what is in the store, so it is
  deterministic, as store migrations must be.
- A pasted `TLContent` payload is migrated per record, not per store,
  so the cross-record rewrite cannot ride the schema path. The paste
  wrapper around `putContentOntoCurrentPage` — which already does
  operation-scoped preprocessing for frame remapping — applies the
  same rewrite rules to the payload first: resolve each binding, write
  the action's target key, and only then let the remap mint fresh
  identities. Pasted output is new content, so it is written in the
  new vocabulary, without bindings.

Retained bindings alone cannot make rollback safe, because the
materialized `videoKey` prop is itself a poison pill to the release
currently deployed: its `youtube-embed` schema does not declare the
property, and tldraw validation rejects unknown props, so a migrated
document would fail to load before any binding is consulted. (The
action's target key has no such problem — frames live in `shape.meta`,
which tldraw does not validate, so older code just ignores the extra
key.) Rollback therefore gets an explicit floor: a pre-release ships
first, with no new features and two small changes. It declares
`videoKey` as an optional prop it never writes, and it narrows the
mount-path cleanup to delete only markers that have neither a binding
nor a target key — true legacy orphans — so markers authored later in
the new vocabulary, which carry a target key and no binding, pass
through it untouched. Everything it authors itself still uses
bindings. The main release follows once the pre-release is deployed,
and rolling back means rolling back to the pre-release; rolling back
past it is out of the support window. A fixture proves a migrated
snapshot validates against the pre-release's exact schema.

Well-formed bindings are rewritten but not deleted. Deleting them
would make an ordinary deployment rollback destructive: the previous
release resolves events through bindings and deletes an unbound marker
as an orphan, so a document opened once by the new release and then
reopened by the old one would silently lose its media events. Left in
place — inert to the new code, intact to the old — they keep
everything the old release wrote survivable under rollback.

Surviving the first open is not enough; the guarantee has to survive
edits. A retained binding points at the original carrier, and a
new-release edit can delete exactly that shape — add a movement
keyframe, then remove the original position. So the batch cleanup that
already watches carrier deletion also tends the retained bindings:
when a binding's video endpoint is deleted while other carriers of its
`videoKey` survive, the binding is repointed at the anchor surviving
carrier, in the same history entry. The old release can then still
resolve the event after any sequence of new-release edits; only when
the last carrier goes do events, markers and bindings go together.

Content
authored by the new release (movement keyframes, new media events,
pasted copies) is written without bindings; under the pre-release it
does not function — nothing there resolves a target key — but it
validates, survives the narrowed cleanup untouched, and works again on
roll-forward.

Fixtures pin all of this. A document captured from the pre-migration
schema, holding a video with `media-control` bindings, must load under
the new schema with its event targeting intact — and, reopened under
the previous release's schema and cleanup rules, must still have its
events, including after the round trip that adds a keyframe and
deletes the originally bound carrier. Another round trip covers the
other direction: an event authored under the main release, opened
under the pre-release, then reopened under the main release, survives
both hops. Sibling fixtures hold the degraded states — an unbound marker,
a binding with a missing or mistyped endpoint — and must come out with
those records gone. A pre-change `TLContent` fixture pasted through
the wrapper must come out with its event targeting the pasted video.

A later release deletes the inert binding records once rolling back to
binding-reading code stops being supported; the schema registration
and the inert util go with them. That cleanup is the whole remaining
compatibility surface, and it is a later judgment call, not a step in
this rollout.
