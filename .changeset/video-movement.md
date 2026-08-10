---
"anipres": minor
---

Let a video move and resize across presentation steps.

A video shape no longer mounts a player. Shapes render a poster and the runtime owns exactly one live player per video, positioned to follow whichever carrier currently represents it, so a copy of a video is harmless and its keyframes become ordinary copies — the follow-up-frame buttons, drag & drop, duplicate-remap and paste all apply to videos unchanged. Videos also stop being exempt from the latest-frame-of-batch visibility rule.

Carriers of one video are tied together by a `videoKey` in their `meta` rather than by the `media-control` binding, which a media event now names directly; a video's shared settings resolve per property by revision stamp, so concurrent edits converge.

The shared-room arbitration for deleting a video's last carrier is designed but not built, so removing the event markers of a deleted video runs only where the client is the document's sole writer; in a synced document those markers are left in place rather than risking their loss to a concurrent edit. A media event whose video has no carrier left is dropped by the timeline derivation either way, so a deleted video leaves no empty steps behind wherever its markers linger, and a carrier of that video returning brings its events back. Carrying a video's settings onto the surviving carriers is not gated that way and runs wherever a carrier is deleted, since deleting the carrier whose revisions won a setting would otherwise drop the video back to a stale carrier's older value.

**Deploy note.** The new vocabulary lives entirely in `meta`, which older builds ignore, so no document becomes unloadable, and media events are still written with the legacy `media-control` binding alongside their own target key so an older build can resolve them rather than deleting them as orphans. `SYNC_CLIENT_VERSION` moves to 4 regardless, since an older client has no notion of a video that moves.
