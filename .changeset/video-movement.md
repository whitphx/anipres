---
"anipres": minor
---

Let a video move and resize across presentation steps.

A video shape no longer mounts a player. Shapes render a poster and the runtime owns exactly one live player per video, positioned to follow whichever carrier currently represents it, so a copy of a video is harmless and its keyframes become ordinary copies — the follow-up-frame buttons, drag & drop, duplicate-remap and paste all apply to videos unchanged. Videos also stop being exempt from the latest-frame-of-batch visibility rule.

Carriers of one video are tied together by a `videoKey` in their `meta` rather than by the `media-control` binding, which a media event now names directly; a video's shared settings resolve per property by revision stamp, so concurrent edits converge.

The shared-room arbitration for deleting a video's last carrier is designed but not built, so removing the event markers of a deleted video runs only where the client is the document's sole writer; in a synced document those markers are left in place rather than risking their loss to a concurrent edit. A media event whose video has no carrier left is dropped by the timeline derivation either way, so a deleted video leaves no empty steps behind wherever its markers linger, and a carrier of that video returning brings its events back. Carrying a video's settings onto the surviving carriers is not gated that way and runs wherever a carrier is deleted, since deleting the carrier whose revisions won a setting would otherwise drop the video back to a stale carrier's older value.

**Deploy note.** A document written before this change records which video a media event controls with a `media-control` binding. Nothing writes or reads one now: `anipres-agent convert <snapshot.json>` rewrites each event to name its video directly and removes the bindings, in place and idempotently. It works on the stored records rather than through a live store, so a deck with no media events is left exactly as it was, and one that predates the current tldraw is not migrated as a side effect of being converted. An unconverted document still loads — the binding type stays registered — but its media events control nothing until it is converted, so convert before upgrading a deck. `SYNC_CLIENT_VERSION` moves to 4: an older client has no notion of a video that moves, mounts a player per carrier and keeps them all visible, so a moving video comes up as several independent players.
