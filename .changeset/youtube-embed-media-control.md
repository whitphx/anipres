---
"anipres": minor
---

Add YouTube video embedding with timeline-driven playback control: a new `youtube-embed` shape hosts the YouTube IFrame Player, and `mediaControl` animation frames (play, pause, stop, mute, unmute, setVolume) — carried by `media-control` marker shapes parented to the video — fire as the presentation advances. Step jumps and backward navigation reconcile each player to the state implied by the event history, so playback stays deterministic.
