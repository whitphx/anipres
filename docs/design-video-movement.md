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
composed opacity, and a `z-index` taken from the shape's position in
`getRenderingShapes()`. Shape containers are stacked as siblings by
that `z-index`, so a player container subscribing to the same values
of its anchor carrier sits in the same stacking context: a video
inside a frame is clipped by the frame, a shape drawn above the video
occludes the live player, and a keyframe with a different size resizes
the player — the iframe fills its container, so the embedded player
rescales with no API involvement. During a step tween the transform
and the width/height interpolate between the outgoing and incoming
carriers' values, while clip, opacity and `z-index` follow the
incoming one.

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

A change of anchor only changes which shape's values the player
mirrors, never the player's place in the DOM, so it cannot remount the
iframe — which is what made every re-anchoring scheme on shape-mounted
players unsafe. Viewport culling is deliberately not mirrored: culling
exists to keep thousands of off-screen shapes cheap, one player is not
that, and an off-viewport player is invisible without any help.

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

For existing documents the prop reads as `props.videoKey || shape.id`.
A props migration must be deterministic, so it cannot mint keys; the
fallback identifies each existing video as itself, which is correct
because today every video is exactly one shape.

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
copies. All of them arrive through tldraw's schema migration path, so
that is where the rewrite lives:

- The binding type stays registered (see above), so the old records
  load instead of failing validation.
- A store-level migration resolves, for each `media-control` binding,
  the video shape at its `toId`, and writes that shape's id into the
  `mediaControl` action carried by the marker at its `fromId`. Under
  the fallback rule above that id _is_ the video's `videoKey`, so the
  event keeps its target. Then the binding record is deleted.
- Legacy stores can also hold degraded records — a marker that lost
  its binding, a binding whose endpoint is missing or of the wrong
  type — and today the mount path deletes unbound markers as its
  recovery. That recovery moves into the migration: a marker whose
  `mediaControl` action cannot be given a target — no binding, or a
  binding that does not resolve to a video — is deleted, along with
  any dangling binding. Nothing schema-invalid and nothing silently
  inert survives the rewrite.
- The migration reads only what is in the store, so it is
  deterministic, as store migrations must be.

A fixture document captured from the pre-migration schema, containing
a video with `media-control` bindings, pins the behavior: it must load
under the new schema with its event targeting intact. Sibling fixtures
hold the degraded states — an unbound marker, a binding with a missing
or mistyped endpoint — and must come out with those records gone.

The schema registration and the migration are the whole compatibility
surface; everything behavioral is deleted now. Dropping those two is
possible once no unmigrated document remains, and is a later judgment
call, not a step in this rollout.
