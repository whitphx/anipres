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
- **`media-control`** (`shapes/media-control/`): a small badge marker
  whose `meta.frame` carries one `mediaControl` frame — one marker per
  media event. Its target is recorded by a **`media-control` binding**
  (marker → video). An earlier draft used `parentId` instead, but
  arbitrary shapes are not containers in tldraw: the editor re-parents
  children of a non-container shape back to the page on the next
  interaction, silently severing the link (each new event then minted
  its own track, deleting the video stranded its markers, and moving it
  left them behind). The binding is the one canonical record of the
  relationship, and its `BindingUtil` gives it behavior in one place:
  markers follow the video (`onAfterChangeToShape` repositions them to
  an anchor stored in the binding props — absolute, not delta-based, so
  dragging video and markers together cannot apply the move twice;
  `onAfterChangeFromShape` re-anchors whenever the marker itself moves,
  covering drags, nudges, and align/distribute alike) and are deleted
  with it (`onBeforeDeleteToShape`); tldraw itself remaps
  bindings on copy/paste when both ends are included. Markers are
  editing chrome: hidden in presentation mode (like slide shapes),
  while their frames still drive playback. An unbound marker (e.g.
  pasted alone) renders as a warning badge and its events no-op.

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
them without changes. All events of one video share one track (minted
on first event, reused afterwards), so simultaneous conflicting
commands on one video surface as the existing same-track-split
diagnostic. `setVolume` is absolute rather than relative volume-up/down
so that folding (below) and repeated runs stay deterministic.

The video's own cue track and its media track stay **separate tracks
in the data model** — a step may legally animate the video and fire a
media event at once, which one shared track would turn into a
same-track-split conflict. The timeline UI merges them instead: the
presentation manager maps every track carried by a video or its bound
markers to that video (`$getMediaTrackGroups`), and
`calcFrameBatchUIData` renders tracks sharing a group as one row.
Grouping is display-only; drag & drop keeps operating on each batch's
real track id.

#### Moving a video mid-presentation (designed, not yet displayed)

The v2 model animates a shape by carrying later keyframes on copies of
it — impossible for a video, where a copy would mount a second live
player and playback state lives in the original iframe. The designed
representation is a **marker-carried keyframe**: a marker bound to the
video carrying a `shapeAnimation` cue frame on the video's own track,
whose own transform (`x`, `y`, and the nullable `w`/`h` props) is the
keyframe target. Playback will tween the video shape itself
(`updateShape`, not a temp copy) toward the marker's transform.

What exists today: the marker schema carries the nullable `w`/`h`
target-size props (part of the persisted schema from the start — adding
them later costs a migration), `runFrames` treats marker-carried
`shapeAnimation` frames as timing-only no-ops, and a framed video stays
visible from its appearance step on instead of following the
latest-batch-only visibility rule (later batches on its track are
marker keyframes, never copies to switch to). The editor UI does not
offer creating these keyframes yet, and the follow-up-frame buttons are
withheld for video-carried batches — the default "clone the carrier"
behavior is exactly the second-player hazard.

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
same as a normal advance. A plain forward advance does not reconcile,
so manual interaction with a video (allowed in presentation mode via
single-click editing, like tldraw embeds) is not overridden mid-flow.
Leaving presentation mode pauses every player (positions are kept —
kinder for editing than a full reset).

Because a step run's frames execute across timer waits (frame
`duration`s), every navigation, rerun, and presentation-mode exit bumps
a run generation on the presentation manager; a run checks it between
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
  appends a play event as a new final step (marker + cue frame); the
  user repositions it by dragging in the timeline.
- The frame-edit popover edits the command (and volume for setVolume)
  on media frames. The timeline's per-batch "+" buttons are withheld on
  media batches — "+ Media event" is the one way events are added, and
  chaining ("play, wait, pause" in one step) is done by dragging an
  event onto an earlier step, which merges same-track sequences into
  one batch.
- The `muted`, `controls`, and `altText` props have no editor UI yet
  (defaults only; settable programmatically). They are part of the
  persisted schema from the start because removing or adding props
  later costs a shape-schema migration.
