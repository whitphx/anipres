---
"anipres": minor
"anipres-worker": minor
---

Add YouTube video embedding with timeline-driven playback control: a new `youtube-embed` shape hosts the YouTube IFrame Player, and `mediaControl` animation frames (play, pause, stop, mute, unmute, setVolume) — carried by `media-control` marker shapes bound to the video — fire as the presentation advances. Step jumps and backward navigation reconcile each player to the state implied by the event history, so playback stays deterministic.

The sync version gate now keys on a new `SYNC_CLIENT_VERSION` (exported from `anipres/models`), raised to 3 for the `youtube-embed` and `media-control` records and the `mediaControl` frame action. `TIMELINE_FORMAT_VERSION` stays 2: the shape of a frame record is unchanged. Clients declaring 2 or lower are rejected from sync and snapshot push, so deploy the app before the worker, as with the v1 gate.

Deploying this worker release is one-way: once a document holds a `youtube-embed` or `media-control` record, a worker without those schema registrations cannot load its room. Roll forward rather than back, and keep the registrations in any release that follows. The agent's `presentationState` prompt part also changes shape (per-frame actions instead of one action per batch); the server accepts the previous form and normalizes it, so an older tab's agent requests don't fail with a 400.
