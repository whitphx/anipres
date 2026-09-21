---
"anipres": minor
---

Frames that share a batch can now be reordered by dragging one onto another of them, and a frame dragged to the front becomes the batch's cue.

Dragging inside a batch used to do nothing: a drop on the batch itself was ignored, and a drop just past it split the frame into a step of its own. So the order of two frames already sharing a batch, such as a video's movement and the playback event attached to it, could only be changed by dragging one onto a later batch of the same track and merging the two.

Unlike a drag across steps, which pushes the frames behind it along and sweeps up the same-track batches it passes, this moves exactly the frame being dragged.
