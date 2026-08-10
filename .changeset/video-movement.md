---
"anipres": minor
---

Let a video move and resize across presentation steps.

A video shape no longer mounts a player. Shapes render a poster and the runtime owns exactly one live player per video, positioned to follow whichever carrier currently represents it, so a copy of a video is harmless and its keyframes become ordinary copies — the follow-up-frame buttons, drag & drop, duplicate-remap and paste all apply to videos unchanged. Videos also stop being exempt from the latest-frame-of-batch visibility rule.

Carriers of one video are tied together by a new `videoKey` prop rather than by the `media-control` binding, which a media event now names directly; existing documents are normalized on load.

The shared-room arbitration for deleting a video's last carrier is designed but not built, so that cleanup runs only where the client is the document's sole writer; in a synced document the event markers of a deleted video are left in place rather than risking their loss to a concurrent edit.

**Deploy note.** Opening a document no longer changes it: `videoKey` is written only when a video is first copied — a movement keyframe, a duplicate, a clipboard read — because the previous build's `youtube-embed` validator rejects that property. A document that has not used the feature therefore still loads after a rollback; one that has does not. The design's Rollout section describes the acceptance-only stage that would remove even that, and it has not shipped.
