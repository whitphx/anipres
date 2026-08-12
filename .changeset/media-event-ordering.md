---
"anipres": minor
---

Add a playback event to a video keyframe and it now joins that keyframe's batch, so it runs after the movement rather than alongside it, and the timeline can reorder the two by dragging.

A step's batches run concurrently, so an event on its own track is simultaneous with a video's movement and no order between them exists to be edited: the timeline showed one, arbitrarily, and no drag could change it. Frames within a batch do run in sequence, ordered by a stored key the timeline already drags, which is where an event that happens after a movement belongs.

Selecting a carrier that has no frame of its own still adds a standalone event in a new step, as before, there being no batch to join. `PresentationManager.attachMediaControlCueFrame` is renamed `attachMediaControlFrame`, since which kind of frame it attaches now depends on what the carrier holds.
