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
mounting is governed by a hard budget: at most N live players — N a
host-configurable prop, defaulting to 4 — granted in priority order:
playing, then selected, then nearest the viewport, with ties and
evictions resolved LRU by last playback or interaction time.
Everything over budget shows its poster.

The budget suppresses players; it never rewrites desired state.
Desired playback is folded from events and is the same on every
client, so an over-budget playing video stays logically playing — its
player is simply not mounted, and it is silent. The mounted set is a
pure function of the folded states and the priority order, so it
changes only when they do; suppression cannot oscillate on its own.
Manual interaction joins as a client-local overlay: the runtime
already hears the player's state-change events, and a manual pause or
play recorded there combines with the folded status into an
_effective_ status, cleared by the next media command or by
navigation reconciliation — the moments the fold deliberately retakes
control. The budget's priority order and the playback clock read the
effective status, so a video paused by hand does not advance while
suppressed and does not resume on remount.

When suppression lifts, the player mounts and seeks by the runtime's
playback clock: a per-video (position, observed-at) pair, refreshed
by periodic polls while a player is mounted and on every pause, seek
and suppression. While a suppressed video is effectively playing the
clock advances virtually with elapsed time, so the remount seeks to
the position the video would have reached; while paused — by event or
by hand — it holds. The clock is deliberately client-local — media
events carry commands, not positions, so cross-client position
identity was never a property of the model; what folds identically
everywhere is the status. Effectively playing videos are suppressed
last, but they are not exempt: when they alone exceed the budget, the
least recently started ones go silent — deterministic, and honest
about the browser's limits, where that many simultaneous live iframes
have already stopped being a presentation.

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
when the video is placed — as the placing shape's own id, a choice the
configuration-owner rule below leans on.

- **`videoKey`** — which video instance this is. Keys the live player,
  and is what a media event targets.
- **`trackId`** — which animation sequence a keyframe belongs to.
  Present only when the video is animated.

Carriers of one video share both. An unframed video has a `videoKey`
and no track. The two questions stop being entangled.

The duplicate-vs-rejoin distinction comes for free: the
follow-up-keyframe path is ours and preserves `videoKey`, while
`Cmd+D` and paste run through the remap wrapper, which mints a fresh
one alongside the fresh `trackId` — the new id of the copied
key-named carrier when it is among the copies, and the smallest new
id otherwise. Normalization happens at serialization, while the
source store is still in hand: copying or duplicating resolves the
source video's authoritative values and writes them, at a fresh
revision, onto the payload's new owner — so even a paste into another
document, where the source owner never existed, carries the source's
current configuration rather than a stale keyframe's raw props.
Duplicating a video therefore yields an independent video with its
own player, which is what the gesture implies.

### One video, one configuration

Sharing an identity means sharing a configuration. A carrier copy
carries all of the video's props, and `url`, `videoId`, `start`,
`muted`, `controls` and `altText` describe the video, not a keyframe
— two carriers of one `videoKey` disagreeing on `videoId` is
incoherent. (The `url` prop the URL form round-trips is part of the
set: leaving it carrier-local would let a stale keyframe's form
resubmit an old video selection.)

The invariant needs an owner, not symmetric mirroring: copying edits
in both directions between records only converges by luck under
concurrent sync, where each side's mirror writes race the other's on
the same properties of different records. Nor can the owner be
"whichever carrier is currently earliest" — keyframe order is itself
synced mutable state, so two clients mid-reorder can disagree about
the owner and land edits on different records. The same objection
kills any rule that reads structure, "the smallest surviving id"
included: a concurrent copy or deletion moves it.

So authority follows the data instead of the structure, and it is
tracked **per property**, not per carrier. Alongside the media props,
each carrier holds a revision map — per media prop, a Lamport stamp:
a counter plus the stable id of the editing session that wrote it —
and every property of a video's configuration resolves independently:
the `videoId` read is the `videoId` carrying the highest stamp,
counters compared first, exact ties broken by session id. Stamps are
globally unique, so the order is total and no residue is left for
delivery or retry timing to decide; a carrier-id tiebreak would not
be, because edits are deliberately routed to the same carrier — two
offline clients editing one prop from counter N both write N+1 to
the same record, and only the session id separates them. An edit
writes the edited props, each stamped one past its highest seen
counter, and may land on any carrier — by convention the key-named
shape while it lives, the smallest id otherwise — because
correctness never depends on which record holds a value, only on the
stamp it travels with. Props never stamped resolve from the
key-named carrier, then the smallest id; unstamped values are birth
copies, identical wherever they sit. The same total order governs
reads, transfers, undo's still-resolves check, the server's
regression guard, and the pre-release's stamping.

Per-property resolution is what survives histories a single
per-carrier counter cannot. Two offline clients can go through
divergent deletions and transfers and edit different props on
different survivors, and on convergence each edit wins its own
property; nothing is discarded wholesale. Only edits to the same prop
contend, and that tie is the genuine conflict of concurrent editing —
it resolves deterministically by the stamp's total order and costs
exactly that one property, never a carrier's worth of unrelated
changes. Same-carrier concurrent-edit fixtures run both delivery
orders and a restart-with-retry. Only
three writes ever produce a nonzero revision: an edit; the delete
transfer below; and copy normalization, which stamps a new video's
owner under its own fresh key. Same-key keyframe copies are written
with an empty revision map — their media props are dead data no
reader consults — so adding a keyframe, reordering, and geometry work
can never move authority.

Authority is resolved at read time, not written back. Nothing fans
winners out across records, deliberately: read-time resolution needs
no writes at all, where a standing rewrite pass would turn every
media edit into one write per carrier, racing other clients' passes
on the same properties. tldraw sync ships record updates as per-key
patches — `diffRecord` diffs a record key by key and recurses into
`props` — so a media edit and a concurrent move of the same record
merge, and edits to different props merge wherever they land.

`videoKey` itself stays a value every carrier shares, not a
reference to the authority record: media events target the key, and
player lookup and orphan cleanup ask "does any carrier with this key
survive", never "does the authority survive".

Deletion must not lower a high-water mark. If deleting a carrier
simply removed the highest revision some prop had, a later edit could
stamp a number the deleted record still beats, and restoring that
record (locally, or by another client's undo) would win that prop's
read back with stale values. The batch delete cleanup therefore
transfers authority in the same history entry: when a deleted carrier
holds the resolving value of any prop while other carriers survive,
those values and their revisions are merged onto the smallest-id
survivor, per property, keeping the higher revision. No high-water
mark regresses; an edit after the deletion stamps strictly higher; a
restored carrier ties a transferred revision at best, carrying the
same value. Undoing the deletion needs no reversal of the transfer:
restoring the deleted carrier restores a record whose values the
transfer copied verbatim, so the tie it re-creates is between
identical values, and no revision ever moves backwards. This is a one-shot
write inside a structural delete, the same exposure as the marker
cleanup and binding repointing that already live in that batch, not a
standing reconcile pass over carrier records.

Who performs the transfer follows who owns the merged state. For an
unsynced document the deleting client's batch does, as above. In a
shared room clients do not transfer at all: a client-computed
transfer can be stale on arrival, and worse, its chosen target can
itself be deleted by a concurrent push from a client that never saw
the transfer — leaving the high stamp on two dead records while a
revision-zero survivor resolves. The room server instead repairs
authority as part of its standing per-push invariant: applying a push
gives it each deleted record's pre-image, so when a deleted carrier
held any prop's highest stamp while others survive, the server writes
those values and stamps onto a surviving carrier in the same
transaction — post-merge, the target is by construction a record that
survived. The transport-side monotonicity guard stays as defense
against any other stale write: each media prop and its stamp travel
and apply as one unit, and the server rejects an application that
would lower a prop's stamp on its record. A three-carrier fixture
deletes the authority holder and the would-be transfer target
concurrently, in both delivery orders and through restart-and-retry.

Undo never moves a revision backwards either, because a lowered
revision is indistinguishable from the stale writes the server guard
exists to reject. Undoing a media edit re-imposes the prior value as
a new edit: each affected property is written back stamped one more
than its highest revision — and only if the value being undone still
resolves, so when someone else has edited past it the undo of that
property is a no-op rather than a clobber. Integration fixtures run
media-edit undo and carrier-deletion undo through the real room
server, with and without concurrent newer edits. An edit racing a
deletion can still lose, exactly as an edit to any concurrently
deleted shape can, and no worse. The player reads the resolved
configuration regardless of which carrier is anchored.

Same-key keyframe copies still carry a raw snapshot of the current
values (at revision zero) as a cosmetic courtesy to anything reading
records raw, such as the rollback pre-release's flattened view;
correctness never depends on it. Existing documents have one carrier
per video — the original shape is the authority at revision zero.
Editing `videoId` still reloads the iframe — changing which video
this is is a different operation from moving it, and the reload is
the point.

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

**Delete.** Removing a video's last carrier is deleting the video,
and its event markers go with it in the same operation. The check
runs once against the store after the whole batch, inside the same
history entry — not per shape during the batch, where deleting every
keyframe of a video in one selection would let each removal see the
others' carriers as still present and conclude nothing was orphaned.
Living inside the history entry also means one undo restores markers
and carriers together. Deleting one keyframe of an animated video
leaves the events alone — which the binding's per-shape cascade would
have got wrong.

This is an explicit deletion semantic, not garbage collection from
whatever a client happens to see: markers are removed only as part of
the operation that deletes their video's last carrier. On a shared
room, though, "last" is a claim the deleting client cannot settle —
another client may be extending the video at that moment, and
honoring the marker removals then would strip a surviving video of
its events, a loss no sweep can reconstruct.

So the claim is explicit, and the room's server — which already runs
the custom schema and owns the merged state — arbitrates it. Record
operations carry no intent, and co-occurrence cannot supply it: a
user may delete an event and a keyframe of the same video in one
legitimate batch. The cascade therefore announces itself — the
deleting client sends the room, alongside its push, the video keys it
claims fully deleted — and, per key, the exact marker ids its cascade
removed. Intent is per marker, not per key, because one batch can mix
both kinds: a user may explicitly delete an event in the same
operation that removes the video's last carrier. Only the claimed
marker ids are arbitrated; every other marker removal, an explicit
event deletion batched with anything at all — including a cascade of
its own video — applies as pushed whether or not the claim survives.
Fixtures prove an explicit deletion sticks when co-batched with a
non-last carrier deletion, and when co-batched with a raced
last-carrier cascade, under both delivery orders.

Arbitration is the server's alone. If the merged state still holds a
carrier of a claimed key — a concurrent extension arrived first — the
claim is refused: the claimed marker removals are declined and those
markers rebroadcast, while the same push's explicit removals stand. If none survives, the removals apply, and the claim
leaves a **durable tombstone**: the removed marker records, persisted
in the room's storage next to the document itself, never held only in
connection memory — and persisted transactionally with the data it
protects. The room ordinarily applies changes in memory and snapshots
lazily; a claim-bearing push opts out of that path: the server
persists the updated snapshot and the tombstone in one synchronous
SQLite transaction before acknowledging or broadcasting the push.
Claims are rare — a video deletion — so the eager write costs nothing
measurable. If the transaction fails, neither side commits and the
claim is re-arbitrated when the push retries; fault-injection tests
kill the process at each storage boundary and reconstruct the room. Retention cannot be tied to who is connected or
what they have acknowledged, because tlsync force-resets a client
whose baseline predates its pruned history and then reapplies and
pushes that client's stashed changes on top of the fresh state — an
arbitrarily old offline extension can arrive at any later time. So
retention is long but bounded — "video deletions are rare" is not an
invariant a scripted or hostile editor honors, and unbounded
tombstones would let repeated create-and-delete cycles exhaust the
room's storage while the visible document stays small. Each room
keeps tombstones under a quota, by default the newest 30 days within
a fixed byte budget, both host-configurable, compacting oldest first
and surfacing count and bytes as room observability; a stress test
proves storage and restart cost stay bounded under create/delete
cycles. A key revived after its tombstone was compacted comes back
as a video without events — that bound and its failure mode are
stated contract, not a surprise. Within the bound, restoration is
unconditional: whenever a tombstoned key gains a carrier again, the
server restores its markers, rebroadcasts them, and clears the
tombstone. That is semantically right, not just race repair — fresh
videos mint fresh keys and paste remints them, so a key only ever
returns as a continuation of the deleted video.

Restoration is marker-aware, never bulk resurrection over intent. An
explicit marker removal prunes that marker from its key's tombstone
as well as from the store — so an event deleted by an offline client
stays deleted when the same push revives its video — and a marker the
push itself supplies, an offline edit, is never overwritten by the
tombstone's stale copy: restore puts only markers absent from both
the merged state and the arriving push. Within one push, pruning runs
before restoration; across pushes, the same end state falls out of
ordinary explicit-deletion semantics, since a restored marker deleted
afterwards is just an event deletion.

Explicit-deletion intent must also survive tlsync's force-reset,
which re-bases a long-offline client by discarding its baseline and
reapplying its stashed changes onto fresh server state — where a
stashed marker removal becomes a no-op, the marker being absent from
the snapshot already, and would never reach the server as a record
operation at all. So the intent does not ride the record stash: the
client records each explicit event deletion — marker id and key — in
its own durable state and reports them as prune requests on every
connect until the server acknowledges them. Pruning is idempotent,
and a prune naming a marker no tombstone holds is a no-op. The
reset-path fixture drives the real reset and stash-reapply flow, not
a hand-built final push.

Both delivery orders, a reconnect after offline editing, and a
reconnect so late the client was force-reset all converge on a video
that is entirely gone or entirely intact, with no client-side repair
rule to race. Fixtures run the race in both message orders, through a
reconnect, and through a server restart that reloads tombstones from
storage before the offline client returns — including variants where
the offline client also deleted or edited one of the tombstoned
events, which must stay deleted or keep the edit. Undo on the deleting
client stays whole too: its history entry holds carriers and markers
together, and re-putting an already-restored marker is a no-op, so
the tombstone never fights an undo. Markers left behind for a key
with no carriers and no claim on record — however record operations
were split or ordered — fall to the standing sweep below.

Orphans that no operation removed — a crash mid-batch, or a deletion
performed under the rollback pre-release (see Rollout), which
preserves new-vocabulary markers but does not understand their
targets — are collected by the same standing invariant: on the sync
server after every applied push, and locally, at load and after each
batch, for unsynced documents. A client of a shared room never sweeps
from its own, possibly partial, view. Nor is the sweep a second,
weaker deletion path: its removals commit through the same
transactional, marker-aware tombstone as an accepted cascade claim,
so a carrier arriving late — an offline extension, a force-reset
replay, a rollback-window edit surfacing after roll-forward —
restores swept events exactly as it restores cascade-deleted ones.
Temporary absence is never proof of permanent deletion, and fixtures
land a late carrier after a sweep across delivery orders, a
force-reset, and a server restart.

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

Interactive does not mean pointer-stealing. The player container is
`pointer-events: none` while idle, so selecting, dragging and
resizing the carrier beneath it stay ordinary canvas gestures;
double-clicking the video enters the shape's editing state — the same
convention tldraw's own embed shapes use — which makes the player
interactive until editing ends with a click elsewhere or Escape. In
presentation mode the default flips: canvas editing is off, and the
player takes pointer input when the video's `controls` allow it.

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
binding stops being written. `SYNC_CLIENT_VERSION` moves twice — the
rollback pre-release described below takes 4, the main release 5 —
and the gate becomes two-sided: a server refuses clients newer than
itself as well as older. One number per release is what keeps
rollback coherent at the protocol level, not just the schema level: a
main-release client still open when the deployment rolls back would
otherwise reconnect to a pre-release server and push cascade claims
it cannot arbitrate, losing events to exactly the race the claims
exist to prevent. Refused instead, it reloads into the pre-release
client. An integration fixture connects a main-release client to a
rolled-back pre-release server and proves the refusal.

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
first. Its contract is that every ordinary edit made under it leaves
main-release documents consistent, which means it understands the new
vocabulary without shipping any new feature:

- It ships the main release's persisted schema wholesale — the
  optional props, the migration sequences, and their versions —
  writing none of the new props on its own. Declaring the props alone
  would not be enough: tldraw stamps migration-sequence versions into
  persisted snapshots and checks them when a room loads, so a
  pre-release lacking the main release's migrations would refuse a
  room the main release had opened, however valid its records.
  Schema parity, not record validity, is what makes a snapshot
  persisted by either release load under the other.
- Its duplicate and paste paths run the main release's identity
  remap — shared code, not a reimplementation: a copied video gets a
  fresh `videoKey` by the same rule the main release uses,
  target-keyed markers travel with the copy the way bound markers do,
  and their actions are rewritten to the fresh key. A rollback-window
  duplicate therefore stays an independent video on roll-forward
  instead of rejoining the original.
- Its media-prop editing is authority-routed and revision-stamped,
  exactly as the main release stamps its own edits, so a
  rollback-window edit holds authority on roll-forward instead of
  sitting unread on a non-owner record.
- Its binding delete cascade is `videoKey`-aware: a bound video
  deleted while another carrier of its key survives repoints the
  binding at the survivor instead of cascading into the marker — a
  state only main-release edits can produce, so purely legacy
  documents behave as before. The same delete path performs the
  authority transfer, so revision high-water marks survive
  rollback-window deletions too.
- Its mount-path cleanup narrows to true legacy orphans — markers
  with neither binding nor target key — so new-vocabulary markers
  pass through untouched.

Media events the pre-release authors are dual-written: the legacy
binding its own behavior needs, and the action's target key
alongside. The second half is not optional politeness — schema parity
means the main release's migrations will never rerun over this
content, so nothing else would supply the key on roll-forward, and a
binding-only event would arrive inert. A fixture creates an event
under the pre-release and proves it still targets and controls its
video after roll-forward. The main release follows once the
pre-release is deployed, and rolling back means rolling back to the
pre-release; rolling back past it is out of the support window. A fixture proves the round trip end to
end: it builds and persists a room with the main release's
`TLSocketRoom`, then reopens the snapshot with the pre-release's —
the load succeeding is the proof, record validation alone would not
exercise the migration-version check.

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

Media-prop edits made during the rollback window survive roll-forward
by construction: they are routed and revision-stamped the same way
the main release's own edits are, so they are the authoritative
values every reader resolves after roll-forward. A fixture edits a media prop
through a non-owner carrier under the pre-release and proves it holds
authority after roll-forward.

Fixtures pin all of this. A document captured from the pre-migration
schema, holding a video with `media-control` bindings, must load under
the new schema with its event targeting intact — and, reopened under
the previous release's schema and cleanup rules, must still have its
events, including after the round trip that adds a keyframe and
deletes the originally bound carrier. Another round trip covers the
other direction: an event authored under the main release, opened
under the pre-release, then reopened under the main release, survives
both hops — including the variant where the bound carrier is deleted
while the pre-release is the one running, and the variant where the
_last_ carrier is deleted there, whose now-targetless markers the
load sweep collects on roll-forward. Duplicating and pasting a video
under the pre-release round-trips too: the copy returns to the main
release as an independent identity with its events attached. Sibling fixtures hold the degraded states — an unbound marker,
a binding with a missing or mistyped endpoint — and must come out with
those records gone. A pre-change `TLContent` fixture pasted through
the wrapper must come out with its event targeting the pasted video.

A later release deletes the inert binding records once rolling back to
binding-reading code stops being supported; the schema registration
and the inert util go with them. That cleanup is the whole remaining
compatibility surface, and it is a later judgment call, not a step in
this rollout.
