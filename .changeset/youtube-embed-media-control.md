---
"anipres": minor
"anipres-worker": minor
---

Add YouTube video embedding with timeline-driven playback control: a new `youtube-embed` shape hosts the YouTube IFrame Player, and `mediaControl` animation frames (play, pause, stop, mute, unmute, setVolume) — carried by `media-control` marker shapes bound to the video — fire as the presentation advances. Step jumps and backward navigation reconcile each player to the state implied by the event history, so playback stays deterministic.

The sync version gate now keys on a new `SYNC_CLIENT_VERSION` (exported from `anipres/models`), raised to 3 for the `youtube-embed` and `media-control` records and the `mediaControl` frame action. `TIMELINE_FORMAT_VERSION` stays 2: the shape of a frame record is unchanged. The gate matches this version exactly rather than treating it as a floor: a client below it cannot read the records a document may hold, and a client above it would write records the worker has no schema registration for, which the room would reject on save.

**Deploy the worker first.** That is the opposite of the v1 gate, because this release also teaches the worker new record types: until it ships, a newer app has nowhere to store a video. Clients on the previous bundle are rejected the moment the worker lands (the app's existing client-too-old screen) and recover once the app deploy lands and they reload. Deploying this worker release is also one-way: once a document holds a `youtube-embed` or `media-control` record, a worker without those schema registrations cannot load its room. Roll forward rather than back, and keep the registrations in any release that follows. The agent's `presentationState` prompt part also changes shape (per-frame actions instead of one action per batch); the server accepts the previous form and normalizes it, so an older tab's agent requests don't fail with a 400.
