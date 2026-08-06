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
  whether YouTube's own controls show. The component renders the IFrame
  Player (privacy-enhanced host, `enablejsapi=1`) and registers it with
  the per-editor `YouTubePlayerManager`. Like any shape, it may carry a
  regular cue frame (e.g. a `shapeAnimation` appearance step).
- **`media-control`** (`shapes/media-control/`): a small badge marker
  whose `meta.frame` carries one `mediaControl` frame — one marker per
  media event. Its target is its **parent shape**: markers are created
  as children of the video, so tldraw natively moves them with the
  video, cascade-deletes them, and remaps the parent link on
  copy/paste. Markers are editing chrome: hidden in presentation mode
  (like slide shapes), while their frames still drive playback. A
  marker whose parent is not a `youtube-embed` (e.g. pasted alone)
  renders as a warning badge and its events no-op.

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

Autoplay policy: programmatic unmuted playback can be blocked by the
browser without prior user interaction. The iframe sets
`allow="autoplay"`, and the shape's `muted` prop starts the player
muted for decks that must play a video on their very first step.

### Editor UI

- Toolbar tool creates the shape; an inline form in the empty shape
  parses the pasted URL (`watch`, `youtu.be`, `shorts`, `live`,
  `embed`, or a bare video id).
- With a video selected, the control panel's "+ Media event" button
  appends a play event as a new final step (marker + cue frame); the
  user repositions it by dragging in the timeline.
- The frame-edit popover edits the command (and volume for setVolume)
  on media frames; the timeline's existing "+" buttons chain follow-up
  events by cloning the marker.
- The `muted`, `controls`, and `altText` props have no editor UI yet
  (defaults only; settable programmatically). They are part of the
  persisted schema from the start because removing or adding props
  later costs a shape-schema migration.
