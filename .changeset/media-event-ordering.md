---
"anipres": minor
---

Add a playback event to a video keyframe and it now joins that keyframe's batch, so it runs after the movement rather than alongside it, and dragging it onto a later keyframe of the same video puts it in front of that one instead.

A step's batches run concurrently, so an event on its own track is simultaneous with a video's movement and no order between them exists to be edited: the timeline showed one, arbitrarily, and no drag could change it. Frames within a batch do run in sequence, ordered by a stored key the timeline already drags, which is where an event that happens after a movement belongs.

Where several keyframes of one video are selected, the event joins the one the video is showing at the current step, which puts it where the user is looking and leaves the video's later keyframes ahead of it, so a drag can still merge it in front of one. Selecting a carrier that has no frame of its own still adds a standalone event in a new step, as before, there being no batch to join. `PresentationManager.attachMediaControlCueFrame` is renamed `attachMediaControlFrame`, since which kind of frame it attaches now depends on what the carrier holds.

A video can hold events on two tracks once one of them joins a keyframe's batch, which makes an arrangement the timeline cannot express: two of its events in separate batches of one step run at once, in an order nothing in the document records, and the same-track-split diagnostic cannot see them across two tracks. A drop that would introduce that pair is refused, and adding an event to a carrier whose step already holds one for that video opens a step of its own rather than joining the batch. Two events sharing a batch still run in sequence and are unaffected.
