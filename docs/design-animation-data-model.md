# Design: Animation Data Model v2 — Step Identity + Fractional Order Keys

> This document specifies a revision of the animation/timeline data model in
> `packages/anipres`. It was produced from an architecture review session on
> 2026-07-27. The storage philosophy (animation data embedded in shapes) is
> deliberately preserved; what changes is the _encoding_ of ordering and
> batch membership.

## Status

Implemented. PR #486 carries both this document and the implementation:
the `timeline-model` core (`packages/anipres/src/timeline-model/`), the
runtime integration, the deterministic v1 → v2 migration, the
server-enforced version gate (Risk 6;
`packages/worker/src/animation-data-version.ts` +
`animation-data-version-gate.ts`), and the
diagnostic-resolution Timeline UI (Risk 7 — user-triggered semantic
repairs: align divergent step keys, materialize same-track splits,
freshen duplicate ids, reattach or clear detached sub frames). A sibling
implementation of this design (PR #487, `codex/redesign-data-structure`)
was converged into #486 — the version gate, the before-first-key
regression tests, the byte-for-byte sub-chain migration resume, the
diagnostic-resolution UI, and the app document-list `sortOrder`
comparison fix were ported/adapted from it — and has been closed.

A post-convergence external review hardened the implementation further:
the Timeline edit pipeline is keyed by shape id end-to-end (duplicate
frame ids survive unrelated edits); parsing is strictly total (malformed
actions/indexes classify as `invalid-frame`, with a paste-only mode for
reading reserved step ids); sub-frame-only copies sever their cue
reference; duplicated-step placement is collision-run-aware and
transactional, with duplication and external paste distinguished by
shape identity rather than id collisions; all key generation is
deterministic (Rocicorp's `fractional-indexing` behind the internal
`OrderKey` module — see r8); migration resume
covers arbitrary persisted subsets via chain-position reconstruction;
and duplicate-id repair prefers the cue as keeper, matching the
derivation's representative.

Deliberately deferred (tracked as follow-ups, not part of #486):
opportunistic persistence of semantic repairs (repairs are strictly
user-triggered); the compiled Slidev viewer and the other items under
[Out of Scope](#out-of-scope--related-future-work).

## Revision History

- **r8 (2026-08-02)**: Key implementation switched from
  `fractional-indexing-jittered` to Rocicorp's `fractional-indexing`,
  wrapped behind the internal `OrderKey` module. Jitter dropped: the
  jittered fork can emit invalid trailing-zero keys
  (<https://github.com/TMeerhof/fractional-indexing-jittered/issues/6>),
  and the editor has no concurrent-insertion requirement (sole-user
  deployment). One pinned migration literal changed (`a4k` → `a4l`, a
  midpoint-rounding difference between the fork and upstream) — accepted
  because no persisted data had been migrated yet.
- **r7 (2026-07-27)**: Two corrections to the synthetic-step
  specification from a sixth external review: the "`StepData.id` is the
  stored `stepId`" description is qualified for rule-2 recovery steps
  (the `synthetic` field distinguishes the cases structurally), and the
  synthetic id construction is made **injective** (JSON tuple encoding —
  naive `:`-joining collides because `v1step:` source ids themselves
  contain colons) with `synthstep:` formally reserved: persisted
  `stepId`s using it are diagnosed.
- **r6 (2026-07-27)**: Type/prose alignment in `TimelineDoc`, closing the
  fifth external review: synthetic steps (derivation rule 2 splits) are
  now explicit in the output type via `StepData.synthetic` (reason +
  source `stepId`) instead of an unspecified "flag", and their derived
  ids are specified — deterministic, stable, namespaced
  (`synthstep:`), one per split batch, and _not_ a parse contract
  (the structured field is the source of truth).
- **r5 (2026-07-27)**: Final precision pass, following a fourth external
  design review. Corrects migration procedure step 2 (stamp ids per
  **partition**, not per `globalIndex` group — r4's wording would have
  re-merged the partitions). Withdraws r4's overclaim that key purity
  alone makes subset conversion equivalent to full migration:
  `partitionIndex` depends on the whole original group, so mixed-document
  conversion must **reconstruct groups** from raw v1 cues plus parsed
  `v1step:` ids, reserving persisted partitions (and their track
  occupancy) before first-fitting the remainder. Specifies the
  **lifecycle of duplication maps**: content-level preprocessing of the
  copied `TLContent` is the primary mechanism (order-independent by
  construction); `beforeCreate` remains only as a scoped fallback net.
  Frame-id remapping is keyed by **source shape id** (old-frame-id keys
  collapse under rule-4 duplicate input), with ambiguous `cueFrameId`
  references resolved by the same representative rule as derivation.
- **r4 (2026-07-27)**: Migration partitioning and identity-map completion,
  following a third external design review. Fixes two internal
  inconsistencies in r3: tolerant-migration splits of same-track/same-index
  conflicts now receive **distinct deterministic ids** via partition
  indices (`v1step:<pageId>:<globalIndex>:<partition>`) — r3 gave both
  halves the same `stepId`, which the derivation would have re-merged; and
  migration keys are now a **pure function of the coordinates**
  `(globalIndex, partition)`, closing the partial-migration divergence r3's
  sequence-over-present-groups left open. Risk 6 is corrected: mixed-format
  tolerance is migration/crash recovery, **not** bidirectional
  compatibility with active v1 editors — a server-enforced version gate is
  required before the writer flip. The duplication policy gains
  `trackIdMap` (r3's "fresh tracks per copied cue" broke multi-step
  copies) and is generalized to the rule: every cross-shape identity gets
  an operation-scoped map. Test list extended accordingly.
- **r3 (2026-07-27)**: Pre-implementation hardening, following a second
  external design review. Blocking fixes: migration `stepId`s and key
  sequences are now **deterministic** (concurrent migrations of a synced
  document converge instead of splitting steps); an **equal-key insertion**
  policy (order-preserving collision-run re-keying, executed inline in the
  insert transaction) is defined; duplicate frame ids are handled
  **losslessly** (both shapes kept, `shapeId` as runtime identity) instead
  of last-write-wins. Recorded refinements: tolerant migration fallback for
  invalid v1 documents; repair split into order-preserving normalization
  vs. semantic repair (semantic repairs are never auto-persisted during
  active sync; canonical key comes from a stable representative — smallest
  `frame.id`); grouped duplication and cross-document `stepId` remapping;
  structured `invalid-frame` diagnostics; random jitter adopted as a
  collision-frequency optimization (safe now that identity is `stepId`).
- **r2 (2026-07-27)**: Step identity separated from ordering. An external
  design-review proposal correctly identified that r1's "equal `orderKey` =
  same step" rule is unsound under concurrency: `generateKeyBetween(a, b)`
  is deterministic, so two clients inserting between the same neighbors
  produce byte-identical keys, and the derivation would silently merge two
  independently authored steps. Cue frames now carry an explicit `stepId`
  (grouping) plus a `stepOrderKey` (position); the sub-frame `cueId` field
  is renamed `cueFrameId`. See [Rejected Alternatives](#rejected-alternatives)
  E–F for the superseded encoding and the jitter-as-identity alternative.
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
8. [Canonicalization & Repair](#canonicalization--repair)
9. [Mutation Operations](#mutation-operations)
10. [Duplication & Paste Policy](#duplication--paste-policy)
11. [Deletion, Orphans, and Reconciliation](#deletion-orphans-and-reconciliation)
12. [Undo/Redo and Multiplayer Sync](#undoredo-and-multiplayer-sync)
13. [Derived `TimelineDoc` (Compiled Artifact)](#derived-timelinedoc-compiled-artifact)
14. [Migration from v1](#migration-from-v1)
15. [Code Impact](#code-impact)
16. [Rejected Alternatives](#rejected-alternatives)
17. [Risks & Open Questions](#risks--open-questions)
18. [Out of Scope / Related Future Work](#out-of-scope--related-future-work)

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
- Make the order derivation **total and lossless**: any reachable store
  state renders something; derivation never throws and never hides a shape.
  Every state producible by concurrent `@tldraw/sync` edits must be either
  well-defined or _detectably_ inconsistent — never silently reinterpreted.
- Give steps a **stable identity** independent of their position (needed by
  the Timeline UI, and by future step-level references such as the compiled
  Slidev viewer's click mapping).
- Reduce `Timeline/frame-movement.ts` (`moveFrame`, ~290 lines) to simple key
  arithmetic. **Implementation note:** this goal was deliberately traded
  off. The shipped `moveFrame` preserves the established push/sweep drag
  semantics exactly (frame-granular moves, batch splits/merges,
  intermediate same-track sweep) — a product behavior the redesign must
  not change — so it remains an algorithm of comparable size that emits a
  structural `EditedStep[]`; what the v2 encoding _did_ eliminate is the
  write-side complexity (sentinels, deck-wide renumbering), which is now
  `reconcileEditedSteps`' minimal per-shape diff.

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
invariants that the v1 _encoding_ makes global:

| Symptom                                                                                                                                                                                                               | Root cause                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `reassignGlobalIndexInplace` + writes to every cue shape on reorder/delete                                                                                                                                            | `globalIndex` is a **dense integer**; any insertion/removal forces renumbering across N shapes |
| `999999` sentinels in `ControlPanel.tsx` and `frame-movement.ts` ("will be reindexed later")                                                                                                                          | no way to express "after everything" without knowing all indices                               |
| `moveFrame` (~290 lines of mirrored push-out/merge branches)                                                                                                                                                          | a logical array splice must be expressed as coordinated integer rewrites                       |
| `reconcileShapeDeletion` renumbering + `prevFrameId` relinking                                                                                                                                                        | deleting a shape rips a node out of a distributed linked list and de-densifies the index space |
| Silent data loss in `getFrameBatches`: sub-frames are keyed by `prevFrameId` in a `Record`, so two sub-frames claiming the same predecessor drop one; a dangling `prevFrameId` silently orphans the rest of its chain | linked-list encoding with no integrity guarantees                                              |
| `getGlobalOrder` throws on same-track/same-index — a state two sync clients can legally produce concurrently — and the throw propagates into rendering                                                                | derivation treats a reachable state as unrepresentable                                         |
| Renumbering writes are themselves a multi-record sync burst                                                                                                                                                           | the cost avoided by rejecting a central record reappears, distributed                          |

A related finding, recorded here for posterity: **the topological sort in
`getGlobalOrder` is provably equivalent to "sort by `globalIndex`, group equal
values."** The same-track edges (type 1) require `a.globalIndex <
b.globalIndex` _plus_ track equality, i.e. they are a strict subset of the
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
chain structure — because those are facts about how frames on _different_
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
  repairable, never silently reinterpreted, never silently dropped)

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
  creating a step means minting a fresh `stepId` (via `uniqueId()`;
  migration-minted ids are deterministic — see
  [Migration](#migration-from-v1)). Fractional-key coincidence has **no**
  grouping meaning — two concurrently inserted steps may legitimately
  receive identical `stepOrderKey`s (the key-between algorithm is
  deterministic) and remain distinct steps.
- **Step order** = steps sorted by `(canonical stepOrderKey, stepId)`.
  `stepId` is the permanent tie-break, so ordering is deterministic even
  under key collisions. The _canonical_ key for a step is defined in
  [Canonicalization & Repair](#canonicalization--repair).
- **Invariant (maintained, not assumed)**: all cue frames sharing a `stepId`
  carry the same `stepOrderKey`. Because the fields live on separate
  records, concurrent or partial writes can violate this; the derivation
  canonicalizes in memory and the editor repairs under the rules in
  [Canonicalization & Repair](#canonicalization--repair). Note the write
  cost of the duplication is nil relative to r1: moving a step always
  required rewriting the order key on every cue in it under key-equality
  grouping too.
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

Key generation uses Rocicorp's `fractional-indexing` package, wrapped
behind the internal `OrderKey` module (`timeline-model/order-key.ts`) so
no other file imports the library. Keys are opaque strings compared by
code units, independent of tldraw's types. Generation is fully
**deterministic — no jitter**: the editor has no concurrent or offline
multi-client insertion requirement, and the previously used
`fractional-indexing-jittered` fork can emit invalid keys with trailing
zeroes (<https://github.com/TMeerhof/fractional-indexing-jittered/issues/6>).
Deterministic keys mean two clients inserting between the same neighbors
produce byte-identical keys — safe precisely because identity is carried
by `stepId`, never by key equality; the collision-run handling below
resolves display order. If multi-client editing is added later, a
jittered implementation can be swapped in inside the `OrderKey` module
without touching callers.

### Parsing is soft-fail — and diagnosed

`getFrame(shape)` returns `Frame | undefined` and **never throws**. A
malformed `meta.frame` (wrong shape, unknown version, bad field types) is
treated as "shape has no frame" for playback purposes, and produces a
structured **`invalid-frame` diagnostic** carrying the `shapeId` (plus a
`console.warn` in dev). The diagnostic matters for editing: without it, a
shape with corrupted animation metadata is indistinguishable from a
never-animated shape, and a user would re-animate it, silently orphaning
the broken data. The Timeline UI surfaces these shapes as
"uninterpretable animation data" with inspect/clear affordances. (v1's
throwing guards could take down rendering for a whole document over one
corrupted record, because `$getShapeVisibilitiesInPresentationMode` runs
over every shape.)

## Derivation Semantics

Replaces `getFrameBatches` + `getGlobalOrder` (and the `OrderedTrackItem`
abstraction entirely):

```text
groups   = cue frames grouped by stepId
steps    = groups sorted by (canonicalKey(group), stepId)
batches  = for each cue: [cue, ...subs where sub.cueFrameId === cue.id,
                          sorted by (orderKey, id)]
```

O(n log n), a handful of lines, no graph. The derivation returns the ordered
steps **plus a structured diagnostics list**; it never throws and never
drops a shape. Frames are identified at runtime by their **`shapeId`** (the
one identity tldraw guarantees unique); `frame.id` is data that can be
corrupted by paste bugs, and derivation must survive that. Totality rules:

1. **Divergent `stepOrderKey` within one `stepId`** (producible by
   concurrent/partial sync writes): the group's canonical key — taken from
   the step's _representative_ cue frame, defined in
   [Canonicalization & Repair](#canonicalization--repair) — determines its
   position; all members stay in the step. Diagnostic:
   `step-key-divergence` (stepId, offending shape ids).
2. **Same track appearing twice within one `stepId`** (producible by
   concurrent "join step" edits; breaks playback's predecessor-in-track
   lookup, which assumes ≤1 batch per track per step): the first batch
   (by cue frame id, then shape id) stays; later same-track batches split
   into an immediately following synthetic step. Deterministic,
   playback-safe, diagnostic emitted, trivially fixed by dragging in the
   Timeline. This is **derived behavior only** — never auto-persisted; the
   split is a semantic guess that the user confirms by editing.
3. **Sub-frame with dangling `cueFrameId`** (its cue's shape was deleted):
   the sub-frame is **detached** — excluded from playback, surfaced in the
   Timeline UI as unassigned, with affordances to reattach or delete. It is
   never silently dropped by the derivation itself.
4. **Duplicate frame ids** (paste artifacts that slipped past dedup):
   **lossless.** All shapes involved are kept in the derivation, ordered
   deterministically by shape id — the timeline never hides a shape that
   exists on the canvas. A `duplicate-frame-id` diagnostic is emitted.
   Sub-frames whose `cueFrameId` matches a duplicated cue id attach to one
   cue deterministically (smallest shape id), with the ambiguity noted in
   the diagnostic. The editor's repair affordance assigns a fresh frame id
   to the duplicate — a **semantic** repair (whichever cue keeps the old id
   inherits the sub-frames), so it is surfaced for user resolution, not
   auto-applied.

The derivation remains implemented once and consumed by the three current
call sites (`presentation-manager.ts`, `Timeline/frame-ui-data.ts`,
`headless-editor-utils.ts`).

## Canonicalization & Repair

Two different things hide under "repair", and they get different rules:

**Order-preserving normalization** — rewrites that provably do not change
the derived timeline. The only instance is **collision-run re-keying** (see
[Mutation Operations](#mutation-operations)): items in an equal-key run are
already deterministically ordered by `(key, stepId)`; assigning fresh
distinct keys in that same order changes nothing observable. These
normalizations do not need a repair pass at all — they execute **inline, as
part of the user mutation that needs them** (an insertion between equal
keys), inside that mutation's own transaction.

**Semantic repair** — rewrites that resolve a genuine ambiguity: converging
divergent `stepOrderKey`s, freshening duplicate frame ids, materializing a
same-track split. For these:

- **Playback always canonicalizes in memory.** The derivation applies the
  deterministic rules above so presentation is never blocked.
- **Canonical key = the `stepOrderKey` of the step's representative cue
  frame: the member with the smallest `frame.id`** (falling back to shape
  id if frame ids are duplicated; recomputed if the representative is
  deleted). This replaces r2's "smallest `(stepOrderKey, id)`" rule, which
  was directionally biased — a partially synced step move _toward earlier_
  always won while a move _toward later_ always lost. A representative
  chosen by stable id is independent of move direction, and — the real
  virtue — is a **stable representative**: the canonical key does not flip
  when other members' keys change. The winner under a partial write is
  still arbitrary (it depends on whether the representative's record was
  included), which is why the divergence is diagnosed rather than silently
  accepted.
- **Semantic repairs are never persisted automatically while sync may be
  active.** In particular, r2's "repair after sync reconnection" is
  withdrawn: a repair pass racing legitimate in-flight remote updates could
  clobber a half-arrived step move. Persistence happens through an explicit
  user action ("resolve" affordances on diagnostics in the Timeline), or
  opportunistically only when the application can establish that initial
  synchronization has completed **and** the affected records are unchanged
  since the derivation that produced the diagnostic (verify record
  versions inside the repair transaction; abort on mismatch). Local-only
  documents (no sync) may repair at load.

## Mutation Operations

The payoff table. "Writes" counts shape records touched beyond the frame(s)
being edited:

| Operation                                               | v1                                                                     | v2                                                                                                                                                                                  |
| ------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Append a step at the end                                | write new cue with `getNextGlobalIndex()`                              | new `stepId`, `stepOrderKey = orderKeyBetween(lastStepKey, null)` — **0 extra writes**                                                                                              |
| Insert a step between steps _i_ and _i+1_               | `insertOrderedTrackItem` → renumber **every** later cue shape          | new `stepId`, `stepOrderKey = orderKeyBetween(key_i, key_i+1)` — **0 extra writes** (unless the neighbors form an equal-key run — see below)                                        |
| Add a simultaneous batch to an existing step            | renumber to share an index, then reindex globally                      | copy the target step's `stepId` + `stepOrderKey` onto the new cue — **0 extra writes** (UI prevents a same-track duplicate; derivation rule 2 tolerates it)                         |
| Move a batch to another step                            | full rewrite via `onFrameBatchesChange`                                | copy the target's `stepId` + `stepOrderKey` — **1 write**                                                                                                                           |
| Move a batch out into a new step (Timeline drag & drop) | `moveFrame`: ~290 lines, sentinel indices, full rewrite of all batches | mint `stepId`, compute one key between target neighbors — **1 write**, ~20 lines                                                                                                    |
| Reorder a whole step                                    | renumbering cascade across the deck                                    | write the new `stepOrderKey` on the step's cue frames — **writes = batches in the step** (typically 1–3; identical cost to r1's key-equality encoding, and still local to the step) |
| Delete a cue/sub frame                                  | renumber all cue shapes / relink the sub-frame chain                   | **0 extra writes** (see [Deletion](#deletion-orphans-and-reconciliation))                                                                                                           |
| Add a sub-frame to a batch                              | append to linked list (find tail, set `prevFrameId`)                   | `cueFrameId` + `orderKey = orderKeyBetween(lastSubKey, null)`                                                                                                                       |
| Reorder sub-frames within a batch                       | pointer surgery on the chain                                           | rewrite one sub-frame's `orderKey`                                                                                                                                                  |

`reassignGlobalIndexInplace`, `insertOrderedTrackItem`, `getGlobalOrder`,
the `OrderedTrackItem` type, and every `999999` sentinel are deleted.

### Inserting between equal keys (collision runs)

Distinct `stepId`s keep concurrently inserted steps separate, but equal
`stepOrderKey`s create a later editing problem: `orderKeyBetween(k, k)` is
undefined, so the user cannot insert between two steps whose keys collided.
(The same applies to sub-frame `orderKey`s within a batch.)

Defined operation — **collision-run normalization**, shared by step and
sub-frame insertion:

1. Detect that the insertion position's neighbors carry equal keys.
2. Find the nearest strictly-smaller and strictly-larger keys bounding the
   equal-key run.
3. Generate enough distinct keys between those bounds for the run's
   existing items plus the new item.
4. Assign them in the run's current deterministic order (`(key, stepId)` /
   `(key, id)`), inserting the new item at its position.

```ts
function makeInsertionSpace(
  orderedItems: { id: string; key: string }[],
  insertionIndex: number,
): { updates: { id: string; key: string }[]; insertedKey: string };
```

This rewrites several records, but only within the local run — never the
rest of the deck — and it is **order-preserving**, so it runs inline in the
insert transaction (see [Canonicalization & Repair](#canonicalization--repair))
with no coordination concerns beyond ordinary sync merging. Generation
is deterministic, so two clients inserting between the same neighbors
produce the same key: runs are an expected state, and this normalization
is the designed response — order-preserving, run-local, and identical on
every client, so concurrent normalizations converge under
last-writer-wins.

## Duplication & Paste Policy

Embedding ids in copyable records makes duplication/paste handling the
irreducible cost of this architecture (as in v1). The governing rule:
**every cross-shape identity carried in `meta.frame` — `frame.id`,
`stepId`, `trackId` — gets an operation-scoped map. Relationships among
the copied frames are preserved; links to everything outside the operation
are severed.**

```ts
// frame.id is *supposed* to be unique but may not be (derivation rule 4),
// so frame-id remapping is keyed by the source SHAPE id — the identity
// tldraw actually guarantees. Keying by old frame id would collapse two
// corrupted sources into one entry and propagate the duplication into
// the copies.
const newFrameIdBySourceShapeId = new Map<TLShapeId, NewFrameId>();
// stepId / trackId are intentionally *shared* identities, so old-id keys
// are correct for them:
const stepIdMap = new Map<OldStepId, NewStepId>();
const trackIdMap = new Map<OldTrackId, NewTrackId>();
```

- **Always freshen `frame.id`** on a copied shape whose frame id already
  exists in the document, one fresh id per source _shape_ — so copying a
  document that contains duplicate-id corruption produces a **cleaner
  copy** (each copy gets a distinct id). Sub-frames copied in the same
  operation remap `cueFrameId` through the map (matching the existing
  grouped-paste handling); when the referenced source cue id is ambiguous
  (duplicate sources), resolve it with the **same representative rule as
  derivation** — the cue with the smallest source shape id — attach the
  copied sub-frame to that cue's fresh frame id, and diagnose the
  ambiguity rather than lose the sub-frame. One deterministic
  representative rule serves both subsystems. A sub-frame pasted alone
  arrives detached (derivation rule 3) and is surfaced in the Timeline.
- **Within-document duplication of cue frames: freshen `stepId` through
  `stepIdMap`.** Otherwise a duplicate silently _joins the original's step_
  and fires simultaneously with it. Crucially, the map is per-operation:
  duplicating **several cue frames that share a step** gives all copies the
  _same fresh_ `stepId` and one fresh `stepOrderKey` — they remain
  simultaneous with each other, as a new step placed after the original
  (`orderKeyBetween(original, next)`), but never joined to it. (If product
  feedback favors v1's duplicate-becomes-sub-frame behavior instead, that
  decision is orthogonal to this encoding and can be layered on.)
- **Freshen `trackId` through `trackIdMap` — never per-cue.** `trackId` is
  a cross-shape identity exactly like `stepId`: copying multiple steps of
  the same object (frame A in step 1 and frame B in step 2, both on track
  T) must yield A′ and B′ **sharing one fresh track T′** — otherwise the
  copies land on unrelated tracks and B′ no longer animates from A′
  (playback's predecessor lookup is per-track), destroying the very
  sequence being copied. The copied track never connects to the original's
  track: the original object's animation is unaffected.
- **Cross-document paste**: a foreign `stepId` or `trackId` unknown to this
  document is benign — the pasted cues keep their grouping/tracks and
  become their own step(s), positioned by their (foreign) keys relative to
  existing keys, clamped into range if needed. But a foreign id that
  **already exists locally must be remapped** through the corresponding
  map: two documents with shared ancestry (a file-level copy of a deck)
  contain _identical_ `stepId`s and `trackId`s, and without remapping,
  pasting between them would silently join unrelated steps — or splice
  pasted keyframes into an unrelated local object's animation track.
  Remapping preserves relationships among the pasted frames themselves
  while severing the accidental identities.

There is no chain to re-splice and no index to recompute in any of these
paths.

### Operation scoping (map lifecycle)

"Operation-scoped" needs a concrete boundary: tldraw's per-shape
`beforeCreate` handler does not by itself identify which shapes belong to
one paste — and worse, the policies above (first-fit, shared fresh tracks,
representative resolution) require seeing the operation's **complete** set
of frames, so a shape-at-a-time hook is inherently creation-order-
dependent, violating the determinism the rest of this design is built on.

Primary mechanism: **preprocess the complete copied `TLContent` before it
is inserted into the store.** The codebase already intercepts exactly this
layer on the copy side (`augmentContentWithThemeImageAssets`); the paste
side transform sees every copied shape at once, holds all three maps as
locals of a single function invocation (created, used, and discarded
per call — no shared mutable state, no reset protocol), and is
order-independent by construction. Its output must not depend on shape
iteration order beyond the deterministic sorts specified above.

Fallback: a `beforeCreate` hook remains only as a **safety net** for
creation paths that bypass content insertion. Its scope, if retained: maps
created lazily on first use within the current store transaction and
discarded when it completes (or at the end of the current microtask,
whichever the implementation can hook reliably). Acknowledged limitation:
the net can freshen ids to prevent corruption, but cannot implement the
full relationship-preserving policy — it may see shapes one at a time and
must not pretend otherwise. Anything the net touches should emit a dev
warning so bypassing paths get promoted into the preprocessing layer.

## Deletion, Orphans, and Reconciliation

`reconcileShapeDeletion` (the `afterDelete` side effect) shrinks
dramatically:

- **Sub-frame shape deleted**: nothing to do. No chain to heal; remaining
  sub-frames keep their `cueFrameId` and keys.
- **Cue shape deleted**: no renumbering (step order is unaffected; if it was
  the last member of its step, the step simply vanishes from the
  derivation). Its sub-frames become _detached_ (dangling `cueFrameId`).
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
  the same neighbors generate the same fractional key (the algorithm is
  deterministic) — this is expected, not exceptional. Their distinct `stepId`s keep them separate steps,
  ordered by `(stepOrderKey, stepId)`; a later insertion between them uses
  collision-run normalization.
- **No renumbering storms.** v1's reorder/delete produced write bursts
  across N records — the same multi-record conflict surface a central
  timeline record would have had, just distributed. v2 mutations are 1–2
  records, except whole-step moves and collision-run normalization (both
  local to the step/run involved).
- Residual conflicts are the divergence classes of derivation rules 1–2
  and 4 (partial step-move writes; concurrent joins of the same track into
  one step; duplicate ids past dedup). All are detectable, playback-safe,
  diagnosed, and lossless; persistent resolution follows the
  [Canonicalization & Repair](#canonicalization--repair) rules — never a
  crash, never a silent reinterpretation, never auto-persisted mid-sync.

## Derived `TimelineDoc` (Compiled Artifact)

The normalized timeline view is _not_ a source of truth — it is the
formalized, versioned **output type** of the derivation pipeline:

```ts
interface TimelineDoc {
  version: 1;
  steps: StepData[]; // array order = presentation order
  detachedFrames: FrameData[]; // rule-3 orphans, surfaced not dropped
  diagnostics: TimelineDiagnostic[];
}
interface StepData {
  id: string; // = stored stepId (stable) — or a derived
  //   synthetic id when `synthetic` is set
  batches: BatchData[];
  synthetic?: {
    // present ONLY on rule-2 recovery steps
    reason: "same-track-split";
    sourceStepId: string; // the stored stepId the batch split from
  };
}
interface BatchData {
  trackId: string;
  frames: FrameData[];
} // frames[0] = cue
interface FrameData {
  frameId: string;
  shapeId: TLShapeId;
  action: FrameAction;
}

type TimelineDiagnostic =
  | { type: "step-key-divergence"; stepId: string; shapeIds: TLShapeId[] }
  | {
      type: "same-track-split";
      stepId: string;
      trackId: string;
      shapeIds: TLShapeId[];
    }
  | { type: "detached-sub-frame"; shapeId: TLShapeId; cueFrameId: string }
  | { type: "duplicate-frame-id"; frameId: string; shapeIds: TLShapeId[] }
  | { type: "invalid-frame"; shapeId: TLShapeId };
```

`FrameData` carries **both** ids: `shapeId` is the unambiguous runtime
identity (unique by tldraw's guarantee — what derivation keys on),
`frameId` is the stored datum (which duplicates can corrupt — what
diagnostics report on).

For a normal step, `StepData.id` is the stored `stepId` — a **stable
identity across reorders**. For a rule-2 recovery step, it is the
deterministic derived id described below; the `synthetic` field
distinguishes the two cases **structurally**, so consumers never infer
step provenance from the id string. Either way the id is stable, which
gives the Timeline UI stable React keys, gives the repair flow and
diagnostics a durable referent, and gives
future step-level features (the compiled Slidev viewer's click mapping,
step labels, deep links) a foundation without any global timeline record.

**Synthetic steps** (rule-2 same-track splits) are marked by the
`synthetic` field, so consumers — the Timeline UI, the compiled viewer,
diagnostic-resolution code — distinguish stored steps from derived
recovery behavior **structurally, never by parsing id conventions**. Each
split batch gets its _own_ synthetic step (two split same-track batches
cannot share a step either), with a derived id:

```ts
const SYNTHETIC_STEP_PREFIX = "synthstep:";
const syntheticStepId = `${SYNTHETIC_STEP_PREFIX}${JSON.stringify([sourceStepId, cueShapeId])}`;
```

where `cueShapeId` is the split batch's cue shape id. The JSON tuple
encoding is required for **injectivity**: naive `:`-joining is not
collision-free, because the components may themselves contain `:` —
`v1step:` source ids always do — so `("a:b", "c")` and `("a", "b:c")`
would concatenate identically. JSON-encoding a tuple of strings is
deterministic and preserves component boundaries regardless of embedded
delimiters. Properties: **deterministic** across repeated derivations and
input iteration orders, **stable** while the source frames are unchanged
(safe as a React key and a diagnostic referent), and **injective** over
its inputs.

`synthstep:` is a **formally reserved prefix for derived `TimelineDoc`
identities**. Persisted `stepId`s must never use it — component-level
injectivity cannot prevent a _stored_ id from colliding with a derived one
unless the namespace itself is reserved — and a persisted `stepId`
carrying the prefix is treated as invalid input: the frame parser emits a
diagnostic for it (and the duplication preprocessing freshens it like any
other id). Unlike `v1step:`, this format is _not_ a parse contract — the
structured `synthetic` field is the source of truth, and the id needs only
the properties above.

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

One-time, mechanical, order-preserving — and **deterministic**, so that any
number of clients migrating the same document concurrently write
byte-identical records and converge under per-record last-writer-wins.

### Determinism (blocking requirement)

Randomly minted migration ids would be a correctness flaw: two v2 clients
concurrently opening the same un-migrated synced document would mint
_different_ `stepId`s for the same v1 step; per-record LWW could interleave
the writes, permanently splitting a step that was simultaneous in v1 — with
`globalIndex` already stripped, the original relationship is
unrecoverable. Therefore:

- **Partitioning within a group.** A v2 step holds at most one batch per
  track, so same-track/same-index v1 conflicts cannot share a step — and
  they must not share a migration `stepId` either, or the derivation would
  re-merge what the migration split. Each `globalIndex` group is
  partitioned deterministically: sort its cue frames by
  `(frame.id, shape.id)`, assign each to the **first partition not already
  containing its `trackId`** (first-fit), and number partitions in
  creation order. A valid v1 document has only partition `0` everywhere;
  conflicts land in partitions `1, 2, …` as adjacent steps, **persistently
  representable** — derivation rule 2 then only ever handles divergence
  that arises later from concurrent edits, never migration output.
- **`stepId`** per partition is a namespaced literal:
  `` `v1step:${pageId}:${globalIndex}:${partitionIndex}` `` — no
  randomness, no hashing needed; the namespace prevents collision with
  `uniqueId()`-minted ids. This format is a **parse contract**: the
  mixed-document path below (and Option B) recover coordinates from it.
  Since tldraw page ids themselves contain `:` (`page:xyz`), parsing must
  take the two _trailing_ numeric segments rather than splitting naively.
- **`stepOrderKey` is a pure function of the coordinates**:
  `getMigratedStepOrderKey(globalIndex, partitionIndex)`, whose output
  depends on nothing but its arguments —
  in particular, not on which other records are currently v1 or v2.
  Construction (Option A): `f(gi)` = the _gi_-th key of the iterated
  key-above chain from the initial key; partition _p_ > 0 = the
  _p_-th key of the iterated key-between chain nested in
  `(f(gi), f(gi+1))` —
  content-independent, and nested strictly between the integer coordinates
  so `(globalIndex, partition)` order is preserved. A naive "ascending
  sequence over the groups present in the document" is **not acceptable**:
  on a partially migrated document it would shift every remaining group's
  key relative to what the full migration wrote (documented fallback,
  Option B: reconstruct the complete coordinate table from raw v1 groups
  plus the parsed `v1step:` ids of already-migrated records, then key the
  union — more moving parts, only if the chosen key library makes Option A
  awkward).
- Intra-batch sub-frame keys: deterministic ascending sequence in chain
  order; `cueFrameId` is the (existing) chain-head frame id. On a
  mixed-batch resume (a chain interrupted mid-migration), chains anchor at
  already-migrated v2 sub frames, and the chain indices those persisted
  keys occupy are **reserved** so the remaining sub frames land on exactly
  the keys a complete run would have assigned — sub-chain resume is
  byte-for-byte, mirroring the cue-level group reconstruction above.

Consequences: migration is **idempotent** (re-running produces identical
records) and concurrent migrations converge regardless of write
interleaving. Note precisely what key purity does and does not buy:
`getMigratedStepOrderKey` is pure in its coordinates, but
**`partitionIndex` is not a pure function of an individual record** — it
depends on the other members of the original group. Subset conversion is
therefore equivalent to full migration only via the **group
reconstruction** rule in [Mixed v1/v2 documents](#mixed-v1v2-documents)
below, not by key purity alone. Cross-client determinism assumes both
clients run the same key-generation algorithm — guaranteed by the version
gate in [Risks](#risks--open-questions) item 6.

### Mixed v1/v2 documents

During rollout, a document may transiently contain both formats (a client
crashed mid-migration; a stale v1-format write landed before the version
gate engaged). The derivation **tolerates mixed records**: v1 frames
encountered at read time are converted in memory via the same deterministic
mapping, yielding exactly the values the persisted migration would have
written, so mixed states converge instead of splitting.

That equivalence requires **group reconstruction** — converting a v1
record in isolation is not enough, because its `partitionIndex` depends on
the group it belonged to. Example: same-track cues A and B share
`globalIndex 4`; a complete migration assigns A → partition 0,
B → partition 1. If only A's write persisted, converting B against the
_remaining v1 records alone_ would see a group containing only B and
assign it partition 0 — recreating, persistently, the very conflict the
partitioning resolves. Therefore, when converting a mixed document:

1. Reconstruct each original `globalIndex` group from **both** the raw v1
   cue frames (via their `globalIndex`) **and** the already-migrated v2
   cue frames whose `v1step:` ids parse back to
   `(globalIndex, partitionIndex)` coordinates.
2. Treat the partitions encoded by existing v2 records as **already
   assigned, including their track occupancy**.
3. Assign the remaining v1 cues using the same `(frame.id, shape.id)` sort
   and first-fit rule as a complete migration.

Because both the complete migration and this reconstruction apply the same
order and first-fit rule, a partial migration resumed this way produces
the **same partition assignment as a complete migration** — this is the
property the resume test below pins down. Degenerate input (a v2 record
whose parsed partition contradicts reconstruction, e.g. two same-track
cues both claiming partition 0 from corrupted writes) is kept as-is and
diagnosed, falling through to derivation rule 2 — migration never
"corrects" persisted v2 records. v2 records whose `stepId` merely
resembles but does not parse as the `v1step:` contract are ordinary v2
records, not group members.

**Scope limit (important): mixed-format tolerance is migration and crash
recovery — not bidirectional editing compatibility.** If v2 editing has
already reordered a step and an active v1 client later overwrites one cue
frame with its stale `globalIndex`, deterministic conversion restores a
_valid_ record at its **original v1 position**; it cannot recover the newer
v2 order that the stale record never contained. Convergent is not the same
as lossless. Active v1 writers must therefore be excluded by the version
gate (Risk 6) before v2 writes are enabled.

### Procedure

1. Run the **legacy** pipeline in a tolerant, non-throwing variant to
   obtain the v1 step order. For valid documents this matches
   `getFrames → getFrameBatches → getGlobalOrder` exactly. For the invalid
   states the strict pipeline throws on or silently drops, the tolerant
   variant maps to v2's representable vocabulary instead of discarding:
   - same-track/same-index conflicts → adjacent steps via the
     deterministic partitioning above (distinct `stepId`s, ordered by
     partition index);
   - forked sub-frame chains (two subs sharing a `prevFrameId`) → **all**
     forks become members of the batch, ordered by frame id;
   - dangling `prevFrameId` references → **detached** frames;
   - duplicate frame ids → all shapes kept (rule 4).
2. Per `(globalIndex, partitionIndex)` partition: stamp its deterministic
   `stepId` + `stepOrderKey` pair on every cue frame **assigned to that
   partition**. Cue frames share a v2 step only when they share a
   partition — v1 simultaneity survives as explicit v2 simultaneity for
   partition `0` (the whole group, in valid documents), while conflict
   partitions become adjacent steps.
3. Stamp each sub-frame with `cueFrameId` + its deterministic intra-batch
   key.
4. Rewrite `meta.frame` to the v2 shape (`v: 2`, drop
   `globalIndex`/`prevFrameId`).

The migration returns a structured result rather than only writes:

```ts
interface MigrationResult {
  updates: ShapeUpdate[];
  diagnostics: MigrationDiagnostic[];
  detachedFrames: { shapeId: TLShapeId; frame: LegacyFrame }[];
}
```

Nothing the legacy pipeline cannot place is permanently discarded —
unplaceable frames persist as v2 detached/diagnosed states for the user to
inspect.

### Trigger points

- **Editor**: on document load in `Anipres` (mount-time store pass), as a
  single history-ignored transaction. (Migration writes are deterministic
  and convergent, so — unlike semantic repairs — they are safe to persist
  at load even for synced documents.)
- **Read-only paths** (headless step counting, future compiled viewer):
  convert **in memory** without writing — read paths must not mutate
  documents.
- **Slidev addon**: snapshots under `.slidev/anipres/snapshots/*.json`
  migrate on the first dev-mode edit/save; playback of un-migrated
  snapshots uses the in-memory conversion.

The legacy parsing/derivation module is kept (internal, deprecated) for at
least one major version, then removed. v1 frames that fail even tolerant
legacy parsing fall under the soft-fail rule: shape treated as unframed,
`invalid-frame` diagnostic emitted.

## Code Impact

| File                                               | Impact                                                                                                                                                                                                                                           |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/ordered-track-item.ts` + tests                | **deleted** (type, `getGlobalOrder`, `insertOrderedTrackItem`, `reassignGlobalIndexInplace`)                                                                                                                                                     |
| `src/models.ts`                                    | v2 frame types, soft-fail parsers + `invalid-frame` diagnostics, new derivation (`deriveTimeline(frames): TimelineDoc`), canonicalization, `makeInsertionSpace`, legacy v1 module (tolerant variant) split out for migration                     |
| `src/models-and-tracks.ts`                         | re-export surface updated (consumed by external tools — coordinate the break)                                                                                                                                                                    |
| `src/presentation-manager/presentation-manager.ts` | `$getOrderedSteps` calls the shared derivation; `attachCueFrame` mints `stepId` + an `orderKeyBetween(lastStepKey, null)` key; `reconcileShapeDeletion` shrinks to the detached-sub policy; `$getNextGlobalIndex` deleted                        |
| `src/presentation-manager/animation.ts`            | unchanged semantics (predecessor-in-track lookup now reads `TimelineDoc`)                                                                                                                                                                        |
| `src/Timeline/frame-movement.ts`                   | `moveFrame` keeps the v1 push/sweep semantics and emits structural `EditedStep[]`; the ~40-line "key assignment" estimate was traded off for behavior preservation (see Background & Goals note) — write-back is where the simplification landed |
| `src/Timeline/frame-ui-data.ts`                    | consumes `TimelineDoc`; drops `globalIndex` recomputation; keys rows/columns by stable `stepId`/`trackId`; renders detached frames + diagnostics with resolve affordances                                                                        |
| `src/ControlPanel/ControlPanel.tsx`                | `requestCueFrameAddAfter` / `requestSubFrameAddAfter` / batch-change handlers lose sentinels and full-rewrite paths                                                                                                                              |
| `src/Anipres.tsx`                                  | content-level paste/duplicate preprocessing (primary) + scoped `beforeCreate` safety net per [Duplication & Paste Policy](#duplication--paste-policy); deterministic migration on mount                                                          |
| `src/headless-editor-utils.ts`                     | `calculateTotalSteps` reads snapshot JSON directly (no headless Editor)                                                                                                                                                                          |
| `packages/slidev-addon-anipres`                    | no structural change; benefits from cheaper step counting; snapshots migrate lazily                                                                                                                                                              |

Testing: the derivation, canonicalization, `makeInsertionSpace`, and
migration are pure functions over JSON — they get direct unit tests,
including: all four totality rules (with synthetic-step ids verified
deterministic and stable across repeated derivations and input iteration
orders, `StepData.synthetic` populated with the source `stepId`,
**injectivity** exercised with `sourceStepId`/`cueShapeId` values
containing `:` and with distinct input pairs required to yield distinct
ids, and a persisted `stepId` carrying the reserved `synthstep:` prefix
producing an `invalid-frame` diagnostic);
key-collision-with-distinct-`stepId`;
collision-run insertion (steps and sub-frames), plus **concurrent
collision-run normalizations remaining total and lossless after
record-level LWW merging** (re-collided keys degrade back to an ordinary
collision run, never to data loss); divergent-key representative selection
(including representative deletion); duplicate-id losslessness;
**migration determinism** — two independent runs (including two
independent _tolerant_ runs over an invalid document) produce
byte-identical records, ids, partitions, and keys; **partial-migration
determinism** — a partially migrated v1/v2 document derives the same keys
as a complete migration, including the **resume test**: migration
interrupted after converting only one cue of a
same-track/same-`globalIndex` conflict, then resumed via group
reconstruction, produces the identical partition assignment to an
uninterrupted run; same-track/same-`globalIndex` conflicts receive
**distinct deterministic partition `stepId`s** that survive re-derivation
without re-merging; degenerate persisted partitions (contradicting
reconstruction) are kept and diagnosed, never rewritten by migration;
tolerant-migration cases (forked chains, dangling refs); the `v1step:`
**parse contract** against page ids containing `:`; grouped duplication
and cross-document paste preserving relationships through all three maps
(`newFrameIdBySourceShapeId`, `stepIdMap`, **`trackIdMap`** — shared
tracks stay shared among copies; colliding foreign track ids remap without
breaking pasted-frame relationships), with the content-preprocessing
transform verified **order-independent** (permuted shape order in
`TLContent` → identical output) and **lossless under duplicate source
frame ids** (two sources sharing a frame id yield copies with distinct
fresh ids; ambiguous `cueFrameId` resolves to the representative and is
diagnosed); a **version-gate test** (a
v1 client is rejected or made read-only after the writer flip — an
integration test at the sync layer); and a v1→v2 golden snapshot fixture.
Existing `ordered-track-item.test.ts` cases are ported to the new
derivation as behavioral tests before the old module is removed.

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
different-track collisions would be silently _merged_ into one step — an
undetectable semantic corruption, since a tie-break can order frames but
cannot recover intent. It also required a fragile usage discipline ("keys
may only be copied, never generated-and-compared") and provided no stable
step identity. Superseded in r2 by `stepId` + `stepOrderKey`, which stores
intent explicitly, at the cost of one duplicated field per step (and zero
additional writes — whole-step moves already touched every member cue
under key equality).

**F. Random jitter as the identity mechanism** (making accidental key
equality improbable while keeping equality-as-identity). Rejected in r2: it
converts a correctness property into a probabilistic one, still cannot
_distinguish_ accident from intent when a collision does occur, and forgoes
stable step identity. Note the r3 distinction: jitter **was** adopted — but
as a frequency optimization that keeps collision runs rare, layered on top
of `stepId`-carried identity, where a collision costs a bounded
normalization instead of a semantic merge. (Superseded in r8: jitter is
dropped entirely; collision runs are handled by normalization rather
than made rare.)

**G. Last-write-wins for duplicate frame ids (r2 rule 4).** Deterministic
but lossy: it removed a shape from the derived timeline before any repair
could happen, contradicting the design's own detached-frames principle
("surface, never drop"). Superseded in r3 by lossless handling keyed on
`shapeId`.

## Risks & Open Questions

1. **Intra-step key redundancy.** `stepOrderKey` is duplicated across a
   step's cue frames and can diverge under concurrent/partial writes. This
   is a _designed-for_ state: derivation rule 1 canonicalizes it in memory
   via the stable representative, and persistence follows the
   [Canonicalization & Repair](#canonicalization--repair) rules. Risk is
   bounded to a step's members (typically 1–3 shapes), and the failure mode
   is a diagnosed, resolvable inconsistency — not data loss or misordering.
2. **Key growth.** Pathological insert patterns lengthen fractional keys.
   At presentation scale this is cosmetic;
   collision-run normalization already re-keys locally, and an optional
   "compact keys" maintenance action can renormalize globally if it ever
   matters.
3. **Duplication semantics** (fresh step vs. v1's append-as-sub-frame) is a
   product decision; the encoding supports either. The policy in
   [Duplication & Paste Policy](#duplication--paste-policy) is the
   proposed default.
4. **External consumers of `anipres/models`.** The `./models` entry point is
   consumed outside this repo (agent CLI, worker). The v2 types are a
   breaking change to that surface — needs a coordinated major bump and the
   legacy module exported during the transition.
5. **Key implementation choice.** Resolved (r8): key generation uses
   Rocicorp's `fractional-indexing` behind the `OrderKey` module,
   independent of tldraw's index-key API. The **migration key sequence
   is pinned to that implementation** — changing it later would break
   migration determinism across app versions (mitigated by the version
   gate below, but avoid churn here).
6. **Rollout requires a server-enforced version gate.** Two-phase deploy
   (reader support first, writer flip second) is necessary but not
   sufficient: before v2 writes are enabled on a synced document, sync must
   enforce a minimum client/schema version, and **v1 clients must be
   prevented from editing or syncing after the writer flip** — mixed-format
   tolerance recovers interrupted migrations, but a stale v1 write against
   a v2-edited document silently reverts newer ordering (see the scope
   limit in [Migration](#migration-from-v1)). Note tldraw's built-in store
   schema versioning does not cover `meta` contents, so the gate must be
   explicit — a sync-handshake check or a document-level version record;
   the exact mechanism is an implementation decision. Within the v2-writer
   era, concurrent migrations are safe by determinism.
7. **Diagnostic-resolution UX** (resolve affordances for divergent keys,
   duplicate ids, same-track splits) is new UI surface for the Timeline;
   scope it minimally (badge + "accept current order" / "fix" actions) to
   avoid this design stalling on UI polish.

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
