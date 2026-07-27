# Design: Animation Data Model v2 — Fractional Order Keys

> This document specifies a revision of the animation/timeline data model in
> `packages/anipres`. It was produced from an architecture review session on
> 2026-07-27. The storage philosophy (animation data embedded in shapes) is
> deliberately preserved; what changes is the *encoding* of ordering and
> batch membership.

## Status

Proposal. Not implemented. No code changes accompany this document.

## Table of Contents

1. [Background & Goals](#background--goals)
2. [Current Model (v1)](#current-model-v1)
3. [What v1 Gets Right — and Must Be Preserved](#what-v1-gets-right--and-must-be-preserved)
4. [Problems with the v1 Encoding](#problems-with-the-v1-encoding)
5. [Key Insight: Existence vs. Relational Invariants](#key-insight-existence-vs-relational-invariants)
6. [The v2 Encoding](#the-v2-encoding)
7. [Derivation Semantics](#derivation-semantics)
8. [Mutation Operations](#mutation-operations)
9. [Deletion, Orphans, and Reconciliation](#deletion-orphans-and-reconciliation)
10. [Undo/Redo and Multiplayer Sync](#undoredo-and-multiplayer-sync)
11. [Derived `TimelineDoc` (Compiled Artifact)](#derived-timelinedoc-compiled-artifact)
12. [Migration from v1](#migration-from-v1)
13. [Code Impact](#code-impact)
14. [Rejected Alternatives](#rejected-alternatives)
15. [Risks & Open Questions](#risks--open-questions)
16. [Out of Scope / Related Future Work](#out-of-scope--related-future-work)

---

## Background & Goals

An anipres presentation is an ordered sequence of **steps**. Each step fires one
or more **frame batches** simultaneously; a batch belongs to a **track** (the
identity of one logical object across its keyframes) and consists of a
user-triggered **cue frame** followed by zero or more auto-chained
**sub-frames**. Keyframes are real tldraw shapes: the shape holds the target
state, and playback interpolates from the previous keyframe in the same track.

Goals of this revision:

- Make insert/reorder/delete of steps and frames **local writes** (touch only
  the shapes being edited, never renumber the rest of the deck).
- Remove the sentinel-value idioms (`999999`, `steps.length + 999999`).
- Replace the sub-frame linked list with an encoding that cannot silently
  lose data.
- Make the order derivation **total**: any reachable store state renders
  something; derivation never throws.
- Reduce `Timeline/frame-movement.ts` (`moveFrame`, ~290 lines) to simple key
  arithmetic.
- Improve behavior under undo/redo and `@tldraw/sync` concurrency.

Non-goals:

- Moving animation data out of shapes (explicitly rejected — see
  [Rejected Alternatives](#rejected-alternatives)).
- Changing the conceptual model (cue/sub frames, tracks, keyframes-as-shapes).
- Performance. v1's O(n²) derivation is irrelevant at realistic deck sizes;
  the simplifications here are for correctness and clarity, not speed.

## Current Model (v1)

Defined in `packages/anipres/src/models.ts` and
`packages/anipres/src/ordered-track-item.ts`. Every animated shape carries
`shape.meta.frame`:

```ts
// Cue frame — triggered by the user's "next" action
{ id, type: "cue", globalIndex: number, trackId: string, action: FrameAction }

// Sub frame — chained after another frame
{ id, type: "sub", prevFrameId: string, action: FrameAction }
```

Derivation pipeline (re-implemented at three call sites:
`presentation-manager.ts`, `Timeline/frame-ui-data.ts`,
`headless-editor-utils.ts`):

1. `getFrames` — scan all shapes, parse `meta.frame` (throwing type guards).
2. `getFrameBatches` — walk `prevFrameId` linked lists from each cue frame.
3. `getGlobalOrder` — build a DAG, topologically sort, group by `globalIndex`.
   Equal `globalIndex` ⇒ same step. Same `trackId` + same `globalIndex` ⇒
   throws `"Cycle or conflict"`.

## What v1 Gets Right — and Must Be Preserved

These properties are load-bearing design decisions, not accidents:

1. **Shapes are the first-class objects of tldraw, and animation data rides on
   them.** Copy, duplicate, cross-document paste, undo, export, and
   `@tldraw/sync` all transport `meta` automatically. There is no separate
   timeline store that can drift out of sync with the canvas, and no
   "orphan shape" class — a shape that exists but is untracked by the
   animation system cannot arise from a missed bookkeeping write.
2. **Sync-friendliness by construction.** tldraw sync resolves conflicts
   per-record (last-writer-wins). Because there is no central timeline
   record, there is no hotspot record over which concurrent editors fight,
   and a remote shape deletion can never leave behind a timeline entry
   pointing at nothing.
3. **Equal order value ⇒ same step** is an elegant encoding of simultaneity
   with no extra structure.
4. The **cue/sub distinction** maps 1:1 to the presentation domain (and to
   Slidev's click model).

v2 keeps all four.

## Problems with the v1 Encoding

All of the fragile code in the current implementation exists to defend
invariants that the v1 *encoding* makes global:

| Symptom | Root cause |
| --- | --- |
| `reassignGlobalIndexInplace` + writes to every cue shape on reorder/delete | `globalIndex` is a **dense integer**; any insertion/removal forces renumbering across N shapes |
| `999999` sentinels in `ControlPanel.tsx` and `frame-movement.ts` ("will be reindexed later") | no way to express "after everything" without knowing all indices |
| `moveFrame` (~290 lines of mirrored push-out/merge branches) | a logical array splice must be expressed as coordinated integer rewrites |
| `reconcileShapeDeletion` renumbering + `prevFrameId` relinking | deleting a shape rips a node out of a distributed linked list and de-densifies the index space |
| Silent data loss in `getFrameBatches`: sub-frames are keyed by `prevFrameId` in a `Record`, so two sub-frames claiming the same predecessor drop one; a dangling `prevFrameId` silently orphans the rest of its chain | linked-list encoding with no integrity guarantees |
| `getGlobalOrder` throws on same-track/same-index — a state two sync clients can legally produce concurrently — and the throw propagates into rendering | derivation treats a reachable state as unrepresentable |
| Renumbering writes are themselves a multi-record sync burst | the cost avoided by rejecting a central record reappears, distributed |

A related finding, recorded here for posterity: **the topological sort in
`getGlobalOrder` is provably equivalent to "sort by `globalIndex`, group equal
values."** The same-track edges (type 1) require `a.globalIndex <
b.globalIndex` *plus* track equality, i.e. they are a strict subset of the
global edges (type 2), which already impose a total order on distinct indices.
The DAG encodes no additional information, cycles are impossible by
construction, and the only detectable conflict is the same-track/same-index
case caught by the explicit nested loop. Every test in
`ordered-track-item.test.ts` passes with the sort-and-group implementation.
This matters not for performance but because it proves v2's simpler derivation
loses no expressiveness.

## Key Insight: Existence vs. Relational Invariants

Embedding data in shapes protects **existence invariants** by construction:
every frame has a shape; every animated shape carries its frame; nothing can
dangle. It cannot protect **relational invariants** — order, step grouping,
chain structure — because those are facts about how frames on *different*
shapes relate, and per-record storage has no cross-record transactions.

v1 encodes its relations through per-shape scalars with global consistency
requirements (dense integers, chain pointers). v2 re-encodes the same
relations so that every mutation is local and every inconsistency is
representable:

- dense integer order → **fractional index keys** (order is relative; no
  renumbering, ever)
- chain pointers → **set membership + local order** (`cueId` + key; no
  relinking, no silent shadowing)
- throwing conflict detection → **deterministic tie-breaks** (derivation is
  total)

## The v2 Encoding

`shape.meta.frame` remains the single source of truth. The fields change:

```ts
// Cue frame
{
  v: 2,
  id: string,
  type: "cue",
  trackId: string,
  orderKey: string,      // fractional index key — global step order
  action: FrameAction,   // unchanged: shapeAnimation | cameraZoom
}

// Sub frame
{
  v: 2,
  id: string,
  type: "sub",
  cueId: string,         // id of the batch's cue frame (membership, not chain)
  orderKey: string,      // fractional index key — position within the batch
  action: FrameAction,
}
```

Semantics:

- **Step order** = cue frames sorted by `orderKey` (string comparison).
- **Simultaneity** = cue frames with an *identical* `orderKey` form one step.
  Discipline: a key is only ever **copied** from a peer to join its step,
  or **generated** (strictly between neighbors / above the last) to create a
  new step. Never generate a key and expect it to equal another.
- **Batch membership** = sub-frames reference their cue by `cueId`;
  intra-batch order = sub-frame `orderKey`. Two sub-frames may no longer
  shadow each other, and removing one requires no pointer surgery on its
  neighbors.
- `trackId` lives only on cue frames; sub-frames inherit the track through
  their cue. Unchanged from v1 in spirit (`newTrackId()` keeps its
  timestamp prefix for stable Timeline row ordering).
- `FrameAction` (`shapeAnimation` / `cameraZoom` with `duration`, `easing`,
  `inset`) is unchanged.
- `v: 2` is a version discriminator for forward migrations. v1 frames are
  recognized by the presence of `globalIndex`/`prevFrameId` and the absence
  of `v`.

Key generation uses tldraw's own fractional-index machinery
(`IndexKey`, `getIndexBetween`, `getIndexAbove`, `sortByIndex`, re-exported
from `@tldraw/utils` — the same mechanism tldraw uses for shape z-order, so
the timeline is ordered the way tldraw itself orders things). If the exact
exports differ in the pinned tldraw version, the `fractional-indexing`
package (already a dependency of `packages/app`) is an equivalent fallback.

### Parsing is soft-fail

`getFrame(shape)` returns `Frame | undefined` and **never throws**. A
malformed `meta.frame` (wrong shape, unknown version, bad field types) is
treated as "shape has no frame" plus a `console.warn` in dev. v1's throwing
guards could take down rendering for a whole document over one corrupted
record, because `$getShapeVisibilitiesInPresentationMode` runs over every
shape.

## Derivation Semantics

Replaces `getFrameBatches` + `getGlobalOrder` (and the `OrderedTrackItem`
abstraction entirely):

```
cues     = all cue frames, sorted by (orderKey, id)         // id = tie-break
steps    = group consecutive cues with equal orderKey
batches  = for each cue: [cue, ...subs where sub.cueId === cue.id,
                          sorted by (orderKey, id)]
```

O(n log n), a dozen lines, no graph. Three totality rules make every
reachable state renderable:

1. **Same track, same `orderKey`** (producible by concurrent sync edits):
   the colliding cues are **split into consecutive steps**, ordered by frame
   id. This deterministically preserves the invariant *at most one batch per
   track per step*, which playback relies on (predecessor-in-track lookup).
   The editing UI may surface a warning badge; playback proceeds.
2. **Sub-frame with dangling `cueId`** (its cue's shape was deleted): the
   sub-frame is **detached** — excluded from playback, surfaced in the
   Timeline UI as unassigned, with affordances to reattach to a batch or
   delete. It is never silently dropped by the derivation itself.
3. **Duplicate frame ids** (paste artifacts that slipped past dedup): last
   write wins deterministically (sorted scan order); a dev warning is logged.

The derivation remains implemented once and consumed by the three current
call sites (`presentation-manager.ts`, `Timeline/frame-ui-data.ts`,
`headless-editor-utils.ts`).

## Mutation Operations

The payoff table. "Writes" counts shape records touched beyond the frame(s)
being edited:

| Operation | v1 | v2 |
| --- | --- | --- |
| Append a step at the end | write new cue with `getNextGlobalIndex()` | `orderKey = getIndexAbove(lastStepKey)` — **0 extra writes** |
| Insert a step between steps *i* and *i+1* | `insertOrderedTrackItem` → renumber **every** later cue shape | `orderKey = getIndexBetween(key_i, key_i+1)` — **0 extra writes** |
| Make batch simultaneous with an existing step | renumber to share an index, then reindex globally | copy the peer step's `orderKey` — **0 extra writes** (guard: target step must not already hold a batch of the same track; the UI prevents, the derivation tolerates via the split rule) |
| Move a batch (Timeline drag & drop) | `moveFrame`: ~290 lines, sentinel indices, full rewrite of all batches via `onFrameBatchesChange` | compute one new key for the moved cue (between/at/copying target neighbors) — **1 write**, ~20 lines |
| Delete a cue/sub frame | renumber all cue shapes / relink the sub-frame chain | **0 extra writes** (see next section) |
| Add a sub-frame to a batch | append to linked list (find tail, set `prevFrameId`) | `cueId` + `orderKey = getIndexAbove(lastSubKey)` |
| Reorder sub-frames within a batch | pointer surgery on the chain | rewrite one sub-frame's `orderKey` |

`reassignGlobalIndexInplace`, `insertOrderedTrackItem`, `getGlobalOrder`,
the `OrderedTrackItem` type, and every `999999` sentinel are deleted.

## Deletion, Orphans, and Reconciliation

`reconcileShapeDeletion` (the `afterDelete` side effect) shrinks
dramatically:

- **Sub-frame shape deleted**: nothing to do. No chain to heal; remaining
  sub-frames keep their `cueId` and keys.
- **Cue shape deleted**: no renumbering (relative order is unaffected). Its
  sub-frames become *detached* (dangling `cueId`). Policy: they are kept and
  surfaced in the Timeline UI rather than auto-deleted — deleting a shape
  should not silently destroy other shapes' animation settings, and undoing
  the deletion restores the cue, at which point the sub-frames are whole
  again with **zero** reconciliation. (v1 could not round-trip this: the
  renumbering rewrote unrelated shapes, and cue deletion silently dropped
  the dependent chain from derivation.)
- An optional explicit "clean up detached frames" action (or a prompt on
  save/export) can garbage-collect long-lived orphans. Automatic GC on
  delete is deliberately avoided to keep deletion undo-clean.

The `beforeCreate` paste/duplicate dedup hook (`Anipres.tsx`) remains — that
is the irreducible cost of embedding ids in copyable records — but it
simplifies: freshen `frame.id` (and remap `cueId` for sub-frames copied
together with their cue, matching the existing grouped-paste handling);
there is no chain to re-splice and no index to recompute.

## Undo/Redo and Multiplayer Sync

- **Undo restores exactly the right state.** Because no other shape is ever
  renumbered, an undo-restored shape's `orderKey` is still valid and slots
  back into precisely its old position. v1 relied on tldraw batching the
  reconciliation writes into the same history entry; v2 has nothing to
  batch.
- **Concurrent inserts interleave cleanly.** Two clients inserting steps at
  the same position generate distinct keys that order deterministically,
  instead of colliding dense integers that trigger the throwing conflict.
- **No renumbering storms.** v1's reorder/delete produced write bursts
  across N records — the same multi-record conflict surface a central
  timeline record would have had, just distributed. v2 mutations are 1–2
  records.
- Residual conflict: two clients concurrently copying the same `orderKey`
  onto same-track cues. Resolved by derivation rule 1 (deterministic split),
  never by a crash.

## Derived `TimelineDoc` (Compiled Artifact)

The normalized timeline view is *not* a source of truth — it is the
formalized, versioned **output type** of the derivation pipeline:

```ts
interface TimelineDoc {
  version: 1;
  steps: StepData[];              // array order = presentation order
}
interface StepData { id: string; batches: BatchData[] }   // simultaneous
interface BatchData { trackId: string; frames: FrameData[] } // frames[0] = cue
interface FrameData { id: string; shapeId: TLShapeId; action: FrameAction }
```

Uses:

- The return shape of the shared derivation (what `presentation-manager`,
  the Timeline UI, and headless utilities consume), replacing the ad-hoc
  `Step = FrameBatch[]` aliases.
- The **compiled export format** for the future tldraw-free Slidev viewer
  (see [Out of Scope](#out-of-scope--related-future-work)) — emitted at
  build/save time alongside rendered shape assets.
- Cheap step counting: because `meta.frame` is plain JSON inside the store
  snapshot, `calculateTotalSteps` can run the derivation directly over
  `snapshot.store` records **without instantiating a headless Editor**.
  This is an independent quick win (removes a per-slide headless tldraw
  boot in the Slidev addon) and should be done regardless of v2.

Because nothing edits a `TimelineDoc`, the orphan/drift concerns that ruled
out a stored timeline record do not apply to it.

## Migration from v1

One-time, mechanical, order-preserving:

1. Run the **legacy** pipeline (`getFrames → getFrameBatches →
   getGlobalOrder`) once to obtain the v1 step order.
2. Generate one fresh index key per step (`getIndicesAbove`-style sequence);
   every cue in a step gets that step's key (equal index ⇒ equal key —
   simultaneity survives).
3. Walk each `prevFrameId` chain once; stamp each sub-frame with
   `cueId = chain head` and sequential intra-batch keys.
4. Rewrite `meta.frame` to the v2 shape (`v: 2`, drop
   `globalIndex`/`prevFrameId`).

Trigger points:

- **Editor**: on document load in `Anipres` (mount-time store pass), as a
  single history-ignored transaction.
- **Read-only paths** (headless step counting, future compiled viewer):
  convert **in memory** without writing — read paths must not mutate
  documents. Persistence happens the next time the document is edited.
- **Slidev addon**: snapshots under `.slidev/anipres/snapshots/*.json`
  migrate on the first dev-mode edit/save; playback of un-migrated
  snapshots uses the in-memory conversion.

The legacy parsing/derivation module is kept (internal, deprecated) for at
least one major version, then removed. v1 frames that fail legacy parsing
fall under the soft-fail rule: shape treated as unframed, warning logged.

## Code Impact

| File | Impact |
| --- | --- |
| `src/ordered-track-item.ts` + tests | **deleted** (type, `getGlobalOrder`, `insertOrderedTrackItem`, `reassignGlobalIndexInplace`) |
| `src/models.ts` | v2 frame types, soft-fail parsers, new derivation (`deriveTimeline(frames): TimelineDoc`), legacy v1 module split out for migration |
| `src/models-and-tracks.ts` | re-export surface updated (consumed by external tools — coordinate the break) |
| `src/presentation-manager/presentation-manager.ts` | `$getOrderedSteps` calls the shared derivation; `attachCueFrame` uses `getIndexAbove`; `reconcileShapeDeletion` shrinks to the detached-sub policy; `$getNextGlobalIndex` deleted |
| `src/presentation-manager/animation.ts` | unchanged semantics (predecessor-in-track lookup now reads `TimelineDoc`) |
| `src/Timeline/frame-movement.ts` | `moveFrame` rewritten as key arithmetic (~20 lines) |
| `src/Timeline/frame-ui-data.ts` | consumes `TimelineDoc`; drops `globalIndex` recomputation |
| `src/ControlPanel/ControlPanel.tsx` | `requestCueFrameAddAfter` / `requestSubFrameAddAfter` / batch-change handlers lose sentinels and full-rewrite paths; frame-add UI gains nothing structural |
| `src/Anipres.tsx` | `beforeCreate` dedup simplified; migration pass on mount |
| `src/headless-editor-utils.ts` | `calculateTotalSteps` reads snapshot JSON directly (no headless Editor) |
| `packages/slidev-addon-anipres` | no structural change; benefits from cheaper step counting; snapshots migrate lazily |

Testing: the derivation and migration are pure functions over JSON — they get
direct unit tests (including the three totality rules and a v1→v2 golden
snapshot fixture). Existing `ordered-track-item.test.ts` cases are ported to
the new derivation as behavioral tests before the old module is removed.

## Rejected Alternatives

**A. Central `TimelineDoc` record as source of truth** (e.g. in `page.meta`).
Atomic reorders and no sentinels — but rejected because it reintroduces the
orphan class this project's design explicitly guards against: tldraw sync
resolves per-record with last-writer-wins, so a concurrent
timeline-record write can resurrect references to remotely-deleted shapes;
copy/paste would need timeline transplant logic; and a single hotspot record
degrades multiplayer editing. The normalized form survives only as a derived
artifact (see above), where nothing can edit it into inconsistency.

**B. Status quo with spot fixes** (keep dense integers, patch `moveFrame`
edge cases, guard the linked-list record). Leaves the renumbering write
bursts, the sentinels, and the throwing derivation in place; every future
timeline feature (e.g. per-frame delays, step labels) would keep paying the
distributed-renumbering tax.

**C. Keyframes as property tracks instead of shape clones** (a conventional
animation model: one live shape per object + `{t, props}` keyframe lists).
Eliminates hidden clone shapes and the visibility engine, but destroys the
product's core UX — editing keyframes directly on canvas with the full
drawing toolset. Not pursued.

**D. Keep the topological sort.** It is a strict no-op over sort-and-group
(proof in [Problems](#problems-with-the-v1-encoding)) and misleads readers
into believing a partial order exists where the encoding defines a total
one.

## Risks & Open Questions

1. **Key-equality discipline.** Simultaneity via identical key strings is
   only safe if keys are copied, never independently generated-and-compared.
   Mitigation: a single `timeline-keys.ts` module owns all key
   creation/copying; direct `getIndexBetween` use outside it is
   lint-forbidden by convention.
2. **Key growth.** Pathological insert patterns lengthen fractional keys.
   At presentation scale this is cosmetic; an optional "compact keys"
   maintenance action (single explicit transaction) can renormalize if it
   ever matters.
3. **Same-key/same-track split rule vs. author intent.** The deterministic
   split keeps playback total but may not match what either concurrent
   editor meant. Acceptable: the state is rare, visible in the Timeline,
   and trivially fixed by dragging.
4. **External consumers of `anipres/models`.** The `./models` entry point is
   consumed outside this repo (agent CLI, worker). The v2 types are a
   breaking change to that surface — needs a coordinated major bump and the
   legacy module exported during the transition.
5. **Exact tldraw index-key API availability** in the pinned version
   (`getIndexBetween` et al.) must be verified at implementation time;
   fallback is the `fractional-indexing` package already used in
   `packages/app`.
6. **Migration trigger for synced documents**: the mount-time migration
   transaction interacts with `@tldraw/sync` (all clients must understand
   v2 before any client writes it). Roll out reader support first, writer
   flip second — standard two-phase deploy.

## Out of Scope / Related Future Work

Captured during the same review, deliberately not part of this design:

- **Compiled Slidev viewer**: emit `TimelineDoc` + rendered shape assets
  (SVG) at author/build time and ship a tldraw-free playback runtime in
  `slidev-addon-anipres`. Motivation: removes tldraw (and its v4+ per-user
  production licensing) from end-user deck bundles entirely, since addon
  editing is already dev-only; also removes the veaury/timing/inverse-scale
  hacks from production paths. The `TimelineDoc` defined here is designed to
  be that compiled format's spine.
- **tldraw v5 upgrade for authoring** (dev-environment use is permitted
  without a production license), unblocked by the compiled viewer.
- Consolidation items from the review: group-recursion helpers, the
  presentation-mode input-suppression spread, dead `offset` prop in
  `SlidevAnipres.vue`, veaury `__veauryReactRef__` reliance, react/tldraw
  `resolve.dedupe`.
