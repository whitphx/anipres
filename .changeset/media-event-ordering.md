---
"anipres": minor
---

Add a playback event to a video keyframe and it now joins that keyframe's batch, so it runs after the movement rather than alongside it, and the timeline can reorder the two by dragging.

A step's batches run concurrently, so an event on its own track is simultaneous with a video's movement and no order between them exists to be edited: the timeline showed one, arbitrarily, and no drag could change it. Frames within a batch do run in sequence, ordered by a stored key the timeline already drags, which is where an event that happens after a movement belongs.

Where several keyframes of one video are selected, the event joins the last of them in presentation order, so it follows all the movement the selection covers and selecting the whole video puts it at the end, where every event used to go. Selecting a carrier that has no frame of its own still adds a standalone event in a new step, as before, there being no batch to join. `PresentationManager.attachMediaControlCueFrame` is renamed `attachMediaControlFrame`, since which kind of frame it attaches now depends on what the carrier holds.

A video can hold events on two tracks once one of them joins a keyframe's batch, so the timeline now refuses a drop that would put two of one video's events in the same step. They would run concurrently, in an order nothing in the document records.
