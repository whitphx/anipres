# Design: Animation Data Model v2 — Step Identity + Fractional Order Keys

> This document specifies a revision of the animation/timeline data model in
> `packages/anipres`. It was produced from an architecture review session on
> 2026-07-27. The storage philosophy (animation data embedded in shapes) is
> deliberately preserved; what changes is the *encoding* of ordering and
> batch membership.

## Status

Proposal. Not implemented. No code changes accompany this document.

## Revision History

- **r2 (2026-07-27)**: Step identity separated from ordering. An external
  design-review proposal correctly identified that r1's "equal `orderKey` =
  same step" rule is unsound under concurrency: `generateKeyBetween(a, b)`
  is deterministic, so two clients inserting between the same neighbors
  produce byte-identical keys, and the derivation would silently merge two
  independently authored steps. Cue frames now carry an explicit `stepId`
  (grouping) plus a `stepOrderKey` (position); the sub-frame `cueId` field
  is renamed `cueFrameId`. See [Rejected Alternatives](#rejected-alternatives)
  E–F for the superseded encoding and the jitter alternative.
- **r1 (2026-07-27)**: Initial proposal (fractional keys, key-equality
  simultaneity).

## Table of Contents

1. [Background & Goals](#background--goals)
2. [Current Model (v1)](#current-model-v1)
3. [What v1 Gets Right — and Must Be Preserved](#what-v1-gets-right--and-must-be-preserved)
4. [Problems with the v1 Encoding](#problems-with-the-v1-encoding)
5. [Key Insight: Existence vs. Relational Invariants](#key-insight-existence-vs-relational-invariants)
6. [The v2 Encoding](#the-v2-encoding)
7. [Derivation Semantics](#derivation-semantics)
8. [Mutation Operations](#mutation-operations)
9. [Duplication & Paste Policy](#duplication--paste-policy)
10. [Deletion, Orphans, and Reconciliation](#deletion-orphans-and-reconciliation)
11. [Undo/Redo and Multiplayer Sync](#undoredo-and-multiplayer-sync)
12. [Derived `TimelineDoc` (Compiled Artifact)](#derived-timelinedoc-compiled-artifact)
13. [Migration from v1](#migration-from-v1)
14. [Code Impact](#code-impact)
15. [Rejected Alternatives](#rejected-alternatives)
16. [Risks & Open Questions](#risks--open-questions)
17. [Out of Scope / Related Future Work](#out-of-scope--related-future-work)

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
  the shapes/step being edited, never renumber the rest of the deck).
- Remove the sentinel-value idioms (`999999`, `steps.length + 999999`).
- Replace the sub-frame linked list with an encoding that cannot silently
  lose data.
- Make the order derivation **total**: any reachable store state renders
  something; derivation never throws. In particular, every state producible
  by concurrent `@tldraw/sync` edits must be either well-defined or
  *detectably* inconsistent — never silently reinterpreted.
- Give steps a **stable identity** independent of their position (needed by
  the Timeline UI, and by future step-level references such as the compiled
  Slidev viewer's click mapping).
- Reduce `Timeline/frame-movement.ts` (`moveFrame`, ~290 lines) to simple key
  arithmetic.

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
3. **Simultaneity is expressed on the cue frames themselves**, with no extra
   structure to maintain elsewhere.
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
- implicit step grouping (index equality) → **explicit step identity**
  (`stepId`; intent is stored, never inferred from key coincidence)
- chain pointers → **set membership + local order** (`cueFrameId` + key; no
  relinking, no silent shadowing)
- throwing conflict detection → **deterministic canonicalization +
  diagnostics** (derivation is total; inconsistencies are detectable and
  repairable, never silently reinterpreted)

## The v2 Encoding

`shape.meta.frame` remains the single source of truth. The fields change:

```ts
// Cue frame
{
  v: 2,
  id: string,
  type: "cue",
  trackId: string,
  stepId: string,        // cue frames with the same stepId are
                         // *intentionally* simultaneous (one step)
  stepOrderKey: string,  // fractional index key — the step's position
                         // in the presentation
  action: FrameAction,   // unchanged: shapeAnimation | cameraZoom
}

// Sub frame
{
  v: 2,
  id: string,
  type: "sub",
  cueFrameId: string,    // id of the batch's cue frame
                         // (membership, not chain position)
  orderKey: string,      // fractional index key — position within the batch
  action: FrameAction,
}
```

Semantics:

- **Step grouping** = cue frames sharing a `stepId`. Grouping is explicit
  intent: joining a step means copying its `stepId` (and `stepOrderKey`);
  creating a step means minting a fresh `stepId` (via `uniqueId()`).
  Fractional-key coincidence has **no** grouping meaning — two concurrently
  inserted steps may legitimately receive identical `stepOrderKey`s (the
  key-between algorithm is deterministic) and remain distinct steps.
- **Step order** = steps sorted by `(canonical stepOrderKey, stepId)`.
  `stepId` is the permanent tie-break, so ordering is deterministic even
  under key collisions. The *canonical* key for a step is defined in
  [Derivation Semantics](#derivation-semantics).
- **Invariant (maintained, not assumed)**: all cue frames sharing a `stepId`
  carry the same `stepOrderKey`. Because the fields live on separate
  records, concurrent or partial writes can violate this; the derivation
  canonicalizes and the editor repairs (below). Note the write cost of the
  duplication is nil relative to r1: moving a step always required
  rewriting the order key on every cue in it under key-equality grouping
  too.
- **Batch membership** = sub-frames reference their cue by `cueFrameId`;
  intra-batch order = sub-frame `orderKey`. Two sub-frames can no longer
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
from `@tldraw/utils` — the same mechanism tldraw uses for shape z-order).
If the exact exports differ in the pinned tldraw version, the
`fractional-indexing` package (already a dependency of `packages/app`) is an
equivalent fallback. No usage discipline is required around key generation:
since grouping is carried by `stepId`, accidental key equality is harmless.

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
groups   = cue frames grouped by stepId
steps    = groups sorted by (canonicalKey(group), stepId)
             where canonicalKey = min over the group of (stepOrderKey, frame id)
batches  = for each cue: [cue, ...subs where sub.cueFrameId === cue.id,
                          sorted by (orderKey, id)]
```

O(n log n), a handful of lines, no graph. The derivation returns the ordered
steps **plus a structured diagnostics list**; it never throws. Totality
rules:

1. **Divergent `stepOrderKey` within one `stepId`** (producible by
   concurrent/partial sync writes): the group's canonical key — the smallest
   `(stepOrderKey, frame id)` pair — determines its position; all members
   stay in the step. A diagnostic (`step-key-divergence`, with the stepId
   and offending frame ids) is emitted for the repair pass.
2. **Same track appearing twice within one `stepId`** (producible by
   concurrent "join step" edits; breaks playback's predecessor-in-track
   lookup, which assumes ≤1 batch per track per step): the first batch
   (by cue frame id) stays; later same-track batches split into an
   immediately following synthetic step. Deterministic, playback-safe,
   diagnostic emitted, trivially fixed by dragging in the Timeline.
3. **Sub-frame with dangling `cueFrameId`** (its cue's shape was deleted):
   the sub-frame is **detached** — excluded from playback, surfaced in the
   Timeline UI as unassigned, with affordances to reattach or delete. It is
   never silently dropped by the derivation itself.
4. **Duplicate frame ids** (paste artifacts that slipped past dedup): last
   write wins deterministically (sorted scan order); diagnostic emitted.

### Repair pass

Diagnostics are not just logs — they drive self-healing. The editor runs a
normalization pass (at document load, alongside the v1→v2 migration hook,
and after sync reconnection) that applies the same canonicalization the
derivation used — e.g. rewriting divergent `stepOrderKey`s to the canonical
value — **in a single history-ignored transaction**. Read-only consumers
(headless step counting, the future compiled viewer) consume the canonical
derivation and never write. This is the general principle applied
throughout: playback is always total *now*; persistent state converges to
consistency at the next edit opportunity.

The derivation remains implemented once and consumed by the three current
call sites (`presentation-manager.ts`, `Timeline/frame-ui-data.ts`,
`headless-editor-utils.ts`).

## Mutation Operations

The payoff table. "Writes" counts shape records touched beyond the frame(s)
being edited:

| Operation | v1 | v2 |
| --- | --- | --- |
| Append a step at the end | write new cue with `getNextGlobalIndex()` | new `stepId`, `stepOrderKey = getIndexAbove(lastStepKey)` — **0 extra writes** |
| Insert a step between steps *i* and *i+1* | `insertOrderedTrackItem` → renumber **every** later cue shape | new `stepId`, `stepOrderKey = getIndexBetween(key_i, key_i+1)` — **0 extra writes** |
| Add a simultaneous batch to an existing step | renumber to share an index, then reindex globally | copy the target step's `stepId` + `stepOrderKey` onto the new cue — **0 extra writes** (UI prevents a same-track duplicate; derivation rule 2 tolerates it) |
| Move a batch to another step | full rewrite via `onFrameBatchesChange` | copy the target's `stepId` + `stepOrderKey` — **1 write** |
| Move a batch out into a new step (Timeline drag & drop) | `moveFrame`: ~290 lines, sentinel indices, full rewrite of all batches | mint `stepId`, compute one key between target neighbors — **1 write**, ~20 lines |
| Reorder a whole step | renumbering cascade across the deck | write the new `stepOrderKey` on the step's cue frames — **writes = batches in the step** (typically 1–3; identical cost to r1's key-equality encoding, and still local to the step) |
| Delete a cue/sub frame | renumber all cue shapes / relink the sub-frame chain | **0 extra writes** (see [Deletion](#deletion-orphans-and-reconciliation)) |
| Add a sub-frame to a batch | append to linked list (find tail, set `prevFrameId`) | `cueFrameId` + `orderKey = getIndexAbove(lastSubKey)` |
| Reorder sub-frames within a batch | pointer surgery on the chain | rewrite one sub-frame's `orderKey` |

`reassignGlobalIndexInplace`, `insertOrderedTrackItem`, `getGlobalOrder`,
the `OrderedTrackItem` type, and every `999999` sentinel are deleted.

## Duplication & Paste Policy

Embedding ids in copyable records makes a `beforeCreate` dedup hook the
irreducible cost of this architecture (as in v1). The v2 hook's policy —
now including `stepId`, which r1 did not have to consider:

- **Always freshen `frame.id`** on a created shape whose frame id already
  exists in the document.
- **Within-document duplication of a cue frame: freshen `stepId` too.**
  Otherwise the duplicate silently *joins the original's step* and fires
  simultaneously with it — surprising, and a change from v1's behavior
  (which converted duplicates into appended sub-frames). The duplicate
  becomes its own step immediately after the original
  (`getIndexBetween(original, next)`), on a fresh track. (If product
  feedback favors v1's duplicate-becomes-sub-frame behavior, that decision
  is orthogonal to this encoding and can be layered on.)
- **Cross-document paste**: an unknown `stepId` is benign — the pasted cue
  is simply its own step of one, positioned by its (foreign) key relative
  to existing keys, clamped into range if needed. Sub-frames pasted
  *together with* their cue get `cueFrameId` remapped to the cue's fresh id
  (matching the existing grouped-paste handling); a sub-frame pasted alone
  arrives detached (rule 3) and is surfaced in the Timeline.

There is no chain to re-splice and no index to recompute in any of these
paths.

## Deletion, Orphans, and Reconciliation

`reconcileShapeDeletion` (the `afterDelete` side effect) shrinks
dramatically:

- **Sub-frame shape deleted**: nothing to do. No chain to heal; remaining
  sub-frames keep their `cueFrameId` and keys.
- **Cue shape deleted**: no renumbering (step order is unaffected; if it was
  the last member of its step, the step simply vanishes from the
  derivation). Its sub-frames become *detached* (dangling `cueFrameId`).
  Policy: they are kept and surfaced in the Timeline UI rather than
  auto-deleted — deleting a shape should not silently destroy other shapes'
  animation settings, and undoing the deletion restores the cue, at which
  point the sub-frames are whole again with **zero** reconciliation. (v1
  could not round-trip this: the renumbering rewrote unrelated shapes, and
  cue deletion silently dropped the dependent chain from derivation.)
- An optional explicit "clean up detached frames" action (or a prompt on
  save/export) can garbage-collect long-lived orphans. Automatic GC on
  delete is deliberately avoided to keep deletion undo-clean.

## Undo/Redo and Multiplayer Sync

- **Undo restores exactly the right state.** Because no other shape is ever
  renumbered, an undo-restored shape's `stepId`/`stepOrderKey` (or
  `cueFrameId`/`orderKey`) are still valid and slot back into precisely the
  old position — including re-adopting detached sub-frames. v1 relied on
  tldraw batching the reconciliation writes into the same history entry;
  v2 has nothing to batch.
- **Concurrent step inserts stay separate.** Two clients inserting between
  the same neighbors deterministically generate the *same* fractional key —
  this is expected, not exceptional. Their distinct `stepId`s keep them
  separate steps, ordered by `(stepOrderKey, stepId)`. No jitter, no
  probabilistic argument, no accidental merge.
- **No renumbering storms.** v1's reorder/delete produced write bursts
  across N records — the same multi-record conflict surface a central
  timeline record would have had, just distributed. v2 mutations are 1–2
  records, except whole-step moves (local to the step's own cues).
- Residual conflicts are the divergence classes of derivation rules 1–2
  (partial step-move writes; concurrent joins of the same track into one
  step). Both are detectable, playback-safe, diagnosed, and converge via
  the repair pass — never a crash, never a silent reinterpretation.

## Derived `TimelineDoc` (Compiled Artifact)

The normalized timeline view is *not* a source of truth — it is the
formalized, versioned **output type** of the derivation pipeline:

```ts
interface TimelineDoc {
  version: 1;
  steps: StepData[];              // array order = presentation order
  diagnostics: TimelineDiagnostic[];
}
interface StepData { id: string; batches: BatchData[] }   // id = stepId (stable)
interface BatchData { trackId: string; frames: FrameData[] } // frames[0] = cue
interface FrameData { id: string; shapeId: TLShapeId; action: FrameAction }
```

`StepData.id` is the stored `stepId` — a **stable identity across
reorders**, not a synthesized value. This gives the Timeline UI stable React
keys, gives the repair pass and diagnostics a durable referent, and gives
future step-level features (the compiled Slidev viewer's click mapping,
step labels, deep links) a foundation without any global timeline record.
(Steps synthesized by derivation rule 2 get a deterministic derived id,
flagged as synthetic.)

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
2. Per v1 `globalIndex` group: mint one `stepId` and one fresh
   `stepOrderKey` (an ascending key sequence); stamp the identical pair on
   every cue frame in the group — v1 simultaneity survives as explicit v2
   simultaneity.
3. Walk each `prevFrameId` chain once; stamp each sub-frame with
   `cueFrameId = chain head` and sequential intra-batch keys.
4. Rewrite `meta.frame` to the v2 shape (`v: 2`, drop
   `globalIndex`/`prevFrameId`).

Trigger points:

- **Editor**: on document load in `Anipres` (mount-time store pass), as a
  single history-ignored transaction — the same hook that hosts the repair
  pass.
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
| `src/models.ts` | v2 frame types, soft-fail parsers, new derivation (`deriveTimeline(frames): TimelineDoc`), repair-pass canonicalization, legacy v1 module split out for migration |
| `src/models-and-tracks.ts` | re-export surface updated (consumed by external tools — coordinate the break) |
| `src/presentation-manager/presentation-manager.ts` | `$getOrderedSteps` calls the shared derivation; `attachCueFrame` mints `stepId` + `getIndexAbove`; `reconcileShapeDeletion` shrinks to the detached-sub policy; `$getNextGlobalIndex` deleted |
| `src/presentation-manager/animation.ts` | unchanged semantics (predecessor-in-track lookup now reads `TimelineDoc`) |
| `src/Timeline/frame-movement.ts` | `moveFrame` rewritten as `stepId`/key assignment (~20 lines) |
| `src/Timeline/frame-ui-data.ts` | consumes `TimelineDoc`; drops `globalIndex` recomputation; keys rows/columns by stable `stepId`/`trackId`; renders detached frames and diagnostics |
| `src/ControlPanel/ControlPanel.tsx` | `requestCueFrameAddAfter` / `requestSubFrameAddAfter` / batch-change handlers lose sentinels and full-rewrite paths |
| `src/Anipres.tsx` | `beforeCreate` dedup per [Duplication & Paste Policy](#duplication--paste-policy); migration + repair pass on mount |
| `src/headless-editor-utils.ts` | `calculateTotalSteps` reads snapshot JSON directly (no headless Editor) |
| `packages/slidev-addon-anipres` | no structural change; benefits from cheaper step counting; snapshots migrate lazily |

Testing: the derivation, repair canonicalization, and migration are pure
functions over JSON — they get direct unit tests (including all four
totality rules, key-collision-with-distinct-stepId, divergent-key repair,
and a v1→v2 golden snapshot fixture). Existing `ordered-track-item.test.ts`
cases are ported to the new derivation as behavioral tests before the old
module is removed.

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

**E. Key equality as step identity (r1 of this document).** Cue frames
carried a single `orderKey`; identical keys meant one step. Unsound under
concurrency: the key-between algorithm is deterministic, so two clients
inserting a step between the same neighbors mint identical keys, and
different-track collisions would be silently *merged* into one step — an
undetectable semantic corruption, since a tie-break can order frames but
cannot recover intent. It also required a fragile usage discipline ("keys
may only be copied, never generated-and-compared") and provided no stable
step identity. Superseded in r2 by `stepId` + `stepOrderKey`, which stores
intent explicitly, at the cost of one duplicated field per step (and zero
additional writes — whole-step moves already touched every member cue
under key equality).

**F. Random jitter on generated keys** (as suggested by the
`fractional-indexing` documentation) to make accidental equality
improbable while keeping equality-as-identity. Rejected: it converts a
correctness property into a probabilistic one, still cannot *distinguish*
accident from intent when a collision does occur, and forgoes the stable
step identity that `stepId` provides for free.

## Risks & Open Questions

1. **Intra-step key redundancy.** `stepOrderKey` is duplicated across a
   step's cue frames and can diverge under concurrent/partial writes. This
   is a *designed-for* state: derivation rule 1 canonicalizes it, and the
   repair pass converges it. Risk is bounded to a step's members (typically
   1–3 shapes), and the failure mode is a diagnosed, self-healing
   inconsistency — not data loss or misordering.
2. **Key growth.** Pathological insert patterns lengthen fractional keys.
   At presentation scale this is cosmetic; an optional "compact keys"
   maintenance action (single explicit transaction) can renormalize if it
   ever matters.
3. **Duplication semantics** (fresh step vs. v1's append-as-sub-frame) is a
   product decision; the encoding supports either. The policy in
   [Duplication & Paste Policy](#duplication--paste-policy) is the
   proposed default.
4. **External consumers of `anipres/models`.** The `./models` entry point is
   consumed outside this repo (agent CLI, worker). The v2 types are a
   breaking change to that surface — needs a coordinated major bump and the
   legacy module exported during the transition.
5. **Exact tldraw index-key API availability** in the pinned version
   (`getIndexBetween` et al.) must be verified at implementation time;
   fallback is the `fractional-indexing` package already used in
   `packages/app`.
6. **Migration trigger for synced documents**: the mount-time
   migration/repair transaction interacts with `@tldraw/sync` (all clients
   must understand v2 before any client writes it). Roll out reader support
   first, writer flip second — standard two-phase deploy.

## Out of Scope / Related Future Work

Captured during the same review, deliberately not part of this design:

- **Compiled Slidev viewer**: emit `TimelineDoc` + rendered shape assets
  (SVG) at author/build time and ship a tldraw-free playback runtime in
  `slidev-addon-anipres`. Motivation: removes tldraw (and its v4+ per-user
  production licensing) from end-user deck bundles entirely, since addon
  editing is already dev-only; also removes the veaury/timing/inverse-scale
  hacks from production paths. The `TimelineDoc` defined here — with its
  stable `stepId`s for click mapping — is designed to be that compiled
  format's spine.
- **tldraw v5 upgrade for authoring** (dev-environment use is permitted
  without a production license), unblocked by the compiled viewer.
- Consolidation items from the review: group-recursion helpers, the
  presentation-mode input-suppression spread, dead `offset` prop in
  `SlidevAnipres.vue`, veaury `__veauryReactRef__` reliance, react/tldraw
  `resolve.dedupe`.
