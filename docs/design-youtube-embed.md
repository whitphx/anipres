# YouTube embedding and media-control frames

Status: implemented.

## Goal

Embed YouTube videos in an Anipres document and drive playback (play,
pause, stop, mute, unmute, set volume) from the presentation timeline:
as the deck advances through steps, media commands fire alongside shape
animations and camera moves, and jumping between steps leaves each video
in a deterministic state.

## Constraints from the animation data model

The v2 timeline model (see `design-animation-data-model.md`) stores
exactly **one frame per shape** in `shape.meta.frame`; multi-keyframe
tracks exist because each keyframe is carried by a separate shape (a
copy of the animated shape). Everything downstream — derivation,
reconciliation, drag & drop, duplicate-remap, visibility — keys frames
by the carrying shape's id.

A video cannot use per-keyframe copies: the player iframe must stay
mounted across steps or playback state (position, buffering, the fact
that it is playing at all) is lost. So media events need carriers other
than the video shape itself, while still being ordinary frames so the
whole timeline machinery applies unchanged.

## Design

### Shapes

- **`youtube-embed`** (`shapes/youtube-embed/`): the video. Props hold
  the pasted URL, extracted `videoId`, start offset, initial mute, and
  whether YouTube's own controls show. The component renders only a
  container div; the IFrame API creates and owns the player iframe
  inside it (privacy-enhanced host), registered with the per-editor
  `YouTubePlayerManager`. The iframe deliberately stays out of React's
  virtual DOM: a React-rendered iframe and the widget API both mutate
  the element, and each re-render then resets the other side's changes,
  reloading the embed in a loop. The containment approach comes from
  react-youtube. Like any shape, it may carry a regular cue frame
  (e.g. a `shapeAnimation` appearance step).
- **`media-control`** (`shapes/media-control/`): an **invisible
  record** whose `meta.frame` carries one `mediaControl` frame — one
  marker per media event. It is a shape only because shapes and
  bindings are tldraw's extension points for synced records: it never
  renders (`component`/`indicator` return null, zero-size geometry) and
  `getShapeVisibility` in `Anipres` returns `"hidden"` for it in every
  mode, which excludes it from rendering and hit-testing wholesale.
  Interaction paths tldraw does NOT filter by hidden-ness (select-all,
  bounds/zoomToFit, copy) are each handled: the marker parks at its
  video's page origin (`onAfterChangeToShape`), so it can never inflate
  page bounds with a stale position; copy is covered by the
  `getContentFromCurrentPage` wrapper below; select-all sweeping in an
  invisible zero-size marker is harmless. Its visual surface is the
  **media-event strip** the YouTube embed shape's component draws below
  the video (edit mode only): one badge per event with its command icon
  and step number (the timeline's own numbering, counting advances from
  0), navigation-only — clicking a badge selects the
  marker, which highlights its frame in the timeline, where editing and
  deletion live (the frame-edit popover carries the "Delete event"
  action, since there is no canvas object to delete).

  The marker's target is recorded by a **`media-control` binding**
  (marker → video). An earlier draft used `parentId` instead, but
  arbitrary shapes are not containers in tldraw: the editor re-parents
  children of a non-container shape back to the page on the next
  interaction, silently severing the link (each new event then minted
  its own track, deleting the video stranded its markers). The binding
  is the one canonical record of the relationship: markers are deleted
  with their video (`onBeforeDeleteToShape`), and tldraw remaps
  bindings on copy/paste when both ends are included. Because markers
  are unselectable, copying a video could never bring them along
  through selection — `Anipres` wraps `editor.getContentFromCurrentPage`
  (next to the existing `putContentOntoCurrentPage` wrapper) to expand
  any included video with its bound markers, which also carries the
  bindings. An unbound marker (legacy documents, external content) is
  deleted at mount: it is invisible and its events would silently
  no-op.

### Data model

`mediaControl` is a third `FrameAction` type:

```ts
{ type: "mediaControl"; command: "play" | "pause" | "stop" | "mute" | "unmute" | "setVolume"; duration?: number; volume?: number }
```

`volume` (0–100) is setVolume-only. `duration` is the wait before the
batch's next frame, so "play, wait 3 s, pause" is a cue frame plus a sub
frame, exactly like chained animations. Because media events are
ordinary cue/sub frames, steps, tracks, drag & drop, sub-frame
chaining, reconciliation, and the paste/duplicate remap all work on
them without changes. An event added to a carrier that holds a frame
joins that frame's batch, and so sits on the carrier's track; every
other event of the video goes on the video's media track, minted on the
first such event and reused afterwards. Two events landing in one step
on that shared media track are caught by the existing same-track-split
diagnostic. Because a video can hold events on two tracks, the pair
that diagnostic cannot see — one event on each track, in one step — is
refused at the drag instead: `hasSimultaneousMediaEvents` rejects a
drop that would produce it, a drop being the only way to reach it.
Events within one batch are sequential and so never a conflict.
`setVolume` is absolute rather than relative volume-up/down so that
folding (below) and repeated runs stay deterministic.

The `mediaControl` action and the new shape/binding types expand what a
document persists, so `SYNC_CLIENT_VERSION` is bumped to 3 and the sync
gate rejects clients below it. A client from before this feature would
otherwise fail its store load on the unknown `youtube-embed` /
`media-control` records, and parse a `mediaControl` frame as an
`invalid-frame` whose offered repair clears it — losing the event.

There is no rollout ordering to get right: the worker serves the app
bundle (`[assets]` in `wrangler.toml`) and the production job ships
both from one build, so a client can never be ahead of the worker that
has to store its records. What this release does constrain is the
direction — once a document holds the new records, a worker without
their schema registrations can no longer load its room, so it rolls
forward only (see the registration note in
[`design-server-sync.md`](./design-server-sync.md)). A tab left open
across the deploy still runs the previous bundle and is refused by the
gate until it reloads.

The gate matches the declared version exactly rather than treating it
as a floor. Only the too-old direction is reachable under that deploy
topology; answering the too-new one with tldraw's `SERVER_TOO_OLD`
costs nothing and keeps the check meaningful if the two are ever
deployed separately.

The video's own cue track and its media track stay **separate tracks
in the data model** — a step may legally animate the video and fire a
media event at once, which one shared track would turn into a
same-track-split conflict. The timeline UI merges them instead: the
presentation manager maps every track carried by a video or its bound
markers to that video (`$getMediaTrackGroups`), and
`calcFrameBatchUIData` renders tracks sharing a group as one row.
Grouping is display-only; drag & drop keeps operating on each batch's
real track id.

#### Moving a video mid-presentation (superseded)

A marker-carried keyframe was the designed representation while a copy
of a video was impossible: the copy would mount a second live player.
[`design-video-movement.md`](./design-video-movement.md) drops that
constraint by taking the player off the shape, which lets keyframes be
ordinary copies and removes the marker binding along with them. Read
that document instead; the notes below describe only what this build
does today.

`runFrames` treats a marker-carried `shapeAnimation` frame as a
timing-only wait — no editor path creates that pairing, but the agent's
`attachCueFrame` can. A framed video stays visible from its appearance
step on rather than following the latest-frame-of-batch rule, because
the video is always its batch's cue and cannot be replaced by a copy
carrying the later keyframe. The follow-up-frame buttons are withheld
for video-carried batches, since cloning the carrier is exactly the
second-player hazard.

### Playback runtime

`media/youtube-player-manager.ts` holds per-editor `YT.Player`
instances keyed by video shape id, and a **desired playback state** per
video. Commands (from `runStep`) and reconciled states always update
the desired state first and reach the player only when it is ready —
closing the race where a video hidden until its appearance step mounts
its player while the step that plays it is still running.

Navigation is made deterministic by `media/media-state.ts`: playback
state is a fold of the mediaControl event history. On a non-adjacent
`moveTo` (jump or backward), the presentation manager folds all events
up to the _previous_ step and reconciles every known player to that
state; the target step's own events then fire live in `runStep`, the
same as a normal advance. The same reconciliation runs on a forward
advance that interrupts an unfinished media-carrying run (the manager
tracks whether the last started run with media frames settled): the
cancelled run's remaining commands never fire (e.g. the chained pause
of "play, wait, pause"), so playback would otherwise diverge from what
the event history implies. A forward advance after a settled or
media-free run does not reconcile, so manual interaction with a video
(allowed in presentation mode via single-click editing, like tldraw
embeds) is not overridden mid-flow — not even by advancing during a
timed camera zoom.
Entering presentation mode reconciles players to the fold through the
CURRENT step inclusive (`reconcileMediaToCurrentStep`): entry is not a
navigation, so no run fires the step's events live, and the canvas
shows the step's completed state without replaying animations — the
fold-inclusive reconcile makes playback match it. This is the one
point where playback overrides manual interaction: a video the user
started by hand, including one with no events at all, is reset to what
the history implies. Leaving presentation mode pauses every player
(positions are kept — kinder for editing than a full reset).

Because a step run's frames execute across timer waits (frame
`duration`s), every navigation, rerun, and presentation-mode entry or
exit bumps a run generation on the presentation manager; a run checks it between
frames and bails once superseded, so a batch like "play, wait, pause"
can never fire its tail commands over a state a later navigation
already reconciled. The generation check only stops future frames, so
effects a frame already started — the temporary animation shape, its
history-bail tick listener and cleanup timer, a running camera
animation — are registered with the manager as run effects and torn
down at the moment of supersession or cancellation.

Reconciliation covers playing/paused, mute, and volume — aspects the
fold leaves untouched fall back to a per-player baseline captured at
mount (the `muted` prop, the player's initial volume), so rewinding
before an event undoes it. It deliberately does NOT cover timeline
position: how far a video has played depends on wall-clock time between
the user's advances, which no fold of the event history can
reconstruct. The one position guarantee is the reset: a video rewound
to before its first event is parked paused at its configured `start`
(via `seekTo`; the API's `stopVideo()` is documented to leave the
player in an arbitrary non-playing state).

Autoplay policy: programmatic unmuted playback can be blocked by the
browser without prior user interaction. The IFrame API stamps its
generated iframe with the autoplay allow attribute (observed behavior
of the current widget script, not a documented guarantee — re-verify if
autoplay regresses), and the shape's `muted` prop starts the player
muted for decks that must play a video on their very first step.

### Editor UI

- Toolbar tool creates the shape; an inline form in the empty shape
  parses the pasted URL (`watch`, `youtu.be`, `shorts`, `live`,
  `embed`, or a bare video id).
- With a video selected, the control panel's "+ Media event" button
  adds a play event for it (a marker carrying the frame). Where the
  selected carrier holds a frame of its own, the event joins that
  frame's batch as a sub frame and so runs after it; a carrier with no
  frame has no batch to join, so the event becomes a cue frame in a new
  final step. Several selected keyframes of one video are still one
  request about one video, and the event follows the last of them in
  presentation order — a selection is a set, so a rule that read its
  order would place the event differently for selections that look
  identical. The user repositions the event by dragging in the timeline.
- The frame-edit popover edits the command (and volume for setVolume)
  on media frames. The timeline's per-batch "+" buttons are withheld on
  media batches — "+ Media event" is how events are added (a marker
  inside a grouped selection is still cloned by the group "+"), and
  chaining ("play, wait, pause" in one step) is done by dragging an
  event onto an earlier step, which merges same-track sequences into
  one batch.
- The `muted`, `controls`, and `altText` props have no editor UI yet
  (defaults only; settable programmatically). They are part of the
  persisted schema from the start because removing or adding props
  later costs a shape-schema migration.
