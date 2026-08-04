# Design: Compiled Viewer

> This document specifies a build-time compilation step and a tldraw-free
> playback runtime for `slidev-addon-anipres`. It was produced from a
> follow-up review session on 2026-08-04, from the "Out of Scope /
> Related Future Work" list in
> [`design-animation-data-model.md`](./design-animation-data-model.md).
> The authoring experience is deliberately unchanged: tldraw remains the
> editor, and remains a build-time dependency.

## Status

Proposed. Nothing implemented. The Animation Data Model v2 work that
this design builds on (`TimelineDoc`, stable `stepId`s) has shipped in
`anipres` 0.14.0.

## Revision History

- **r1 (2026-08-04)**: Initial proposal. Hybrid scene format (baked SVG
  for static shapes, live descriptors for interactive ones), three
  animation tiers, per-deck fallback to the tldraw runtime.

## Table of Contents

- [Background & Goals](#background--goals)
- [What the Current Runtime Costs](#what-the-current-runtime-costs)
- [Evidence from the Deck Corpus](#evidence-from-the-deck-corpus)
- [Key Insight: Two Axes, Not One](#key-insight-two-axes-not-one)
- [The Compiled Format](#the-compiled-format)
- [Shape Tiers](#shape-tiers)
- [Animation Tiers](#animation-tiers)
- [The Runtime](#the-runtime)
- [The Build Pipeline](#the-build-pipeline)
- [Fallback and Degradation](#fallback-and-degradation)
- [Risks & Open Questions](#risks--open-questions)
- [Spike Plan](#spike-plan)
- [Out of Scope](#out-of-scope)

## Background & Goals

Today a published deck ships the entire tldraw editor to every viewer,
purely to replay animations that were authored ahead of time. Editing is
already dev-only (`import.meta.hot` gates it in `SlidevAnipres.vue`), so
the editor is dead weight in production: it costs bundle size, it drags
in React plus the veaury React-in-Vue bridge, and it forces a set of
timing and scaling workarounds that exist only because a live editor is
rendering into a slide.

Goals, in priority order:

1. **Remove tldraw from end-user deck bundles.** Playback should need
   only the compiled scene and a small runtime.
2. **Delete the workarounds** listed in the next section, rather than
   porting them.
3. **Preserve authored behaviour exactly**, including interactive
   embeds. A compile that silently drops content is worse than no
   compile.
4. **Keep the authoring path untouched.** The editor stays as it is.

Non-goal: changing the data model. `TimelineDoc` is already the right
spine, and its stable `stepId`s were designed for exactly this mapping.

The v2 design doc also records a licensing motivation: removing tldraw
from production bundles avoids tldraw v4+ per-user production licensing
for deck viewers, since dev-environment use is permitted. That motivation
is inherited here rather than re-derived, and the licence terms should be
re-read before they are relied on commercially. Note that compilation
still runs tldraw at build time, which is a development-time use.

## What the Current Runtime Costs

Concrete workarounds in `SlidevAnipres.vue` and `Anipres.tsx` that exist
only because a live editor renders inside a slide:

- **Double-rerender on slide enter and on scale change**, each with
  `setTimeout` retries, because tldraw's rendering does not settle
  synchronously. The code comments say as much ("An immediate rerender
  is sometimes not enough").
- **`resetTextAutoSize`**, which re-updates every text shape because
  tldraw measures `autoSize` text against the DOM and gets it wrong
  before fonts load or while the container is still zero-sized.
- **The veaury `__veauryReactRef__` reach-through** to call
  `rerunStep()` on a React component from Vue.
- **Inverse-scale plumbing** through the `--slide-scale` CSS variable.
- **`lockShortcuts()`** to stop Slidev and tldraw fighting over keys.
- **Presentation-mode input suppression**, including the "click enters
  tldraw's editing state so you can interact with an embed" hack, plus
  the `beforeChange` handler that blanks selection and hover state.

Every one of these is a symptom of not owning the DOM. A compiled
runtime owns it, so none of them need to be ported.

## Evidence from the Deck Corpus

Measured across the 17 converted snapshots in `whitphx/slides` (985
shapes, 204 animation frames). This is the whole production corpus, so
it is a strong guide to what the compiler must actually handle, though
not a guarantee about future decks.

Shape types present:

| type          | count | compiles to                       |
| ------------- | ----- | --------------------------------- |
| `geo`         | 231   | SVG                               |
| `text`        | 214   | SVG                               |
| `line`        | 159   | SVG                               |
| `arrow`       | 122   | SVG                               |
| `group`       | 100   | flattened at compile time         |
| `slide`       | 80    | not rendered (camera region only) |
| `image`       | 55    | SVG                               |
| `theme-image` | 12    | SVG (already implements `toSvg`)  |
| `embed`       | 7     | **live DOM**                      |
| `bookmark`    | 4     | **live DOM**                      |
| `note`        | 1     | SVG                               |

Morphing keyframe pairs, by the type of the shape being morphed:

| morphs                | pairs | props that change                   |
| --------------------- | ----- | ----------------------------------- |
| `slide` (camera zoom) | 62    | `w`/`h` of the camera rect          |
| `geo`                 | 7     | `w`/`h` (4), `fill` (2), `size` (2) |
| `image`               | 1     | none (pure `x`/`y` move)            |

Two conclusions drive the whole design:

1. **Interactive shapes are never animated.** All 11 `embed` and
   `bookmark` shapes carry no animation frame at all. They are static
   content that appears at a step. So the compiler never has to morph an
   iframe, only position, show, and hide it.
2. **Genuine shape morphing is rare.** 62 of 70 morph pairs are camera
   zooms, which are pure arithmetic on bounds. The entire corpus contains
   **eight** real shape morphs.

## Key Insight: Two Axes, Not One

The naive framing is "compile shapes to SVG". That framing fails
immediately, because tldraw's `EmbedShapeUtil` implements no `toSvg` at
all (nor does `BookmarkShapeUtil`), and `VideoShapeUtil.toSvg` exports
only a poster frame from time zero. A pure-SVG compiler would silently
drop the 11 live shapes already in the corpus and freeze any video.

The insight is that compilability has **two independent axes**:

- **Is the shape's appearance static?** If yes it can be baked to SVG.
  If it is live content (an iframe, a `<video>`, a link preview) it must
  stay a real DOM element.
- **Does the shape morph between keyframes?** If it only moves, CSS can
  do it. If its props change, something has to interpolate them.

These are independent, and in practice they are anti-correlated: the
live shapes are exactly the ones that never morph. That is what makes
the design tractable.

## The Compiled Format

One artifact per deck slide, emitted at build time:

```ts
interface CompiledScene {
  version: 1;
  /** The derived timeline, verbatim. Array order = presentation order. */
  timeline: TimelineDoc;
  /** Page-space bounds of the whole scene, for the initial camera. */
  bounds: { x: number; y: number; w: number; h: number };
  /** Every renderable shape, in z-order. */
  layers: CompiledLayer[];
}

type CompiledLayer = StaticLayer | LiveLayer;

interface LayerBase {
  shapeId: string;
  /** Page-space placement; groups are already flattened into this. */
  transform: { x: number; y: number; w: number; h: number; rotation: number };
  opacity: number;
}

interface StaticLayer extends LayerBase {
  kind: "svg";
  /** Baked markup from editor.getSvgString([shape]). */
  svg: string;
}

interface LiveLayer extends LayerBase {
  kind: "embed" | "video" | "bookmark";
  /** Everything the runtime needs to build the real element. */
  source: { url: string /* embed params baked in at compile time */ };
}
```

`timeline` is stored as-is. It already carries `stepId` (stable click
mapping), `trackId`, per-frame `action` with `duration`/`easing`, and the
`shapeId` of every frame, which is the join key to `layers`.

Everything the runtime needs is in this one artifact. It replaces the
`.slidev/anipres/snapshots/*.json` payload in production builds, while
the snapshot remains the authoring source of truth.

## Shape Tiers

**Static shapes** bake through `editor.getSvgString([shape], opts)`,
which accepts a shape subset, so each layer is baked independently
rather than as one page-wide export. Independent baking is what lets
the runtime move and fade layers separately.

**Live shapes** never bake. The compiler records the descriptor and the
runtime creates the element:

- `embed`: an `<iframe>`. The compiler resolves the embed definition and
  bakes the final URL, including the YouTube parameters that PR #172
  currently injects at runtime (`enablejsapi=1`, `mute=1`, `origin`).
- `video`: a `<video>` element, with the poster frame optionally baked
  alongside for first paint.
- `bookmark`: the link preview card, rendered from its already-fetched
  metadata.

**The `slide` shape is not a layer at all.** It is a camera region: the
presentation runtime hides it (`$getShapeVisibilitiesInPresentationMode`
returns `hidden` for it today) and uses only its bounds for
`cameraZoom`. The compiler emits its bounds into the timeline's camera
actions and drops the shape.

**Groups** are flattened. A group contributes no markup of its own; its
transform is composed into each descendant layer's page-space
`transform`. Eleven framed shapes in the corpus are nested inside
groups, so this is required, not optional.

### Why embeds get simpler, not harder

This is worth stating explicitly, because the intuition runs the other
way. PR #172 (`autoplay-youtube`) has to fight tldraw for DOM ownership:
it monkey-patches `DEFAULT_EMBED_DEFINITIONS` to add the IFrame API
parameters, runs a document-wide `MutationObserver` to notice when
tldraw creates an iframe, and recovers the shape id from
`iframe.parentElement.id`. `Anipres.tsx` separately has to enter
tldraw's _editing state_ on click so the user can interact with an embed
during presentation.

In the compiled runtime the iframe is ours. Parameters are baked at
build time, the element reference is held in a map keyed by `shapeId`,
and the YouTube IFrame API is called directly when the owning step
activates. The `MutationObserver`, the id recovery, and the
editing-state hack all disappear, and "autoplay when the step is
reached", which is a `TODO` comment in #172 today, becomes an ordinary
feature of the step runtime.

## Animation Tiers

The runtime must reproduce three behaviours that
`presentation-manager/animation.ts` currently delegates to tldraw.

**Tier 1: camera (`cameraZoom`).** Today this is
`editor.zoomToBounds(bounds, { inset, duration, easing })`. Compiled, it
is a CSS transform on the scene container computed from the target
bounds, the viewport size, and `inset`. No shape rendering is involved.
This covers 62 of 70 morph pairs.

**Tier 2: transform-only shape animation.** When consecutive keyframes
differ only in `x`, `y`, `rotation` (and uniform scale), the runtime
crossfades between the two baked layers while transforming, using the
frame's `duration` and `easing`. Note that a non-uniform `w`/`h` change
is **not** expressible as a CSS `scale()`, because that would scale
stroke widths too.

**Tier 3: prop morphing.** When props other than the transform change
(`w`/`h`, `fill`, `size`), CSS cannot express the tween, because tldraw
re-renders the shape per frame via `getInterpolatedProps`. Three options,
in increasing fidelity and cost:

- **(a) Crossfade** between the two baked endpoint layers while
  transforming. Cheap, and for a rectangle growing slightly it is close
  to indistinguishable.
- **(b) Pre-baked intermediate frames.** At compile time, lerp the props
  in the editor and bake N intermediate SVGs, then play them as a
  sprite sequence. Exact, at the cost of artifact size.
- **(c) Reimplement interpolation** in the runtime for the specific prop
  subset. Highest fidelity, highest maintenance, and it re-imports the
  complexity we are trying to delete.

**Recommendation: implement (a), and add (b) behind a per-frame opt-in
if a deck needs it.** The corpus contains eight Tier 3 pairs, so (b)
would cost single-digit numbers of extra bakes per deck even if applied
everywhere. Option (c) is not worth it.

### Visibility

Orthogonal to the tiers, and already specified by the derivation: only
the last frame of a track's most recently played batch is visible;
everything else on that track is hidden. The compiled runtime computes
exactly this from `timeline`, which is a pure function of the step
index. It is simpler than the current implementation because there is no
`getShapeVisibility` callback to satisfy.

## The Runtime

A small Vue component in `slidev-addon-anipres`, replacing the veaury
bridge in production builds:

- Renders `layers` as absolutely positioned elements inside a scene
  container: `<svg>`/`<img>` for `kind: "svg"`, real elements for live
  layers.
- Maps Slidev's click index to a step index, exactly as
  `SlidevAnipres.vue` does today via `calculateTotalSteps`. Since
  `timeline.steps.length` is now a plain array length, `calculateTotalSteps`
  stops needing to parse a tldraw snapshot at all.
- On step change: applies the camera transform, plays Tier 2/3
  transitions, updates visibility, and notifies live layers (for example
  `player.playVideo()` on a YouTube layer whose step just became
  active).
- Has no editor, no store, no React, and no tldraw import.

The authoring path is unchanged: in dev, `import.meta.hot` is present,
the existing editor mounts, and saving still writes the snapshot JSON.

## The Build Pipeline

The addon's existing Vite plugin already owns the snapshot lifecycle
(it receives `anipres-snapshot` over the hot channel and serves
snapshots through the `/@slidev-anipres-snapshot` virtual module). The
compiler slots in there:

1. On production build, for each snapshot, boot a headless editor. The
   machinery exists: `loadHeadlessEditor` in `headless-editor-utils.ts`.
2. Derive the timeline with `deriveTimeline`. Any diagnostic is a build
   warning. Once PR #490 lands, an unconverted deck surfaces as a
   `v1-frame` diagnostic, which should be a build error telling the
   author to convert the deck rather than a warning; before then, 0.14.x
   still migrates v1 data on load and the case cannot arise.
3. Partition shapes into static and live, flatten groups, bake static
   layers with `editor.getSvgString`.
4. Emit `CompiledScene` and have the virtual module serve it instead of
   the raw snapshot.

Dev builds keep serving the snapshot, so authoring is unaffected and the
compiler only runs where it pays off.

## Fallback and Degradation

The compiler must never silently produce a lesser deck. Two rules:

- **Unknown shape type**, or a static shape whose `toSvg` returns
  `null`: fail the compile for that deck with a message naming the shape
  and type, and fall back to shipping the tldraw runtime for that deck.
  Per-deck granularity keeps one exotic shape from disabling the
  optimisation everywhere.
- **An explicit opt-out** (`compile: false` on the component) for
  authors who hit a fidelity problem and need the old path immediately.

This makes adoption incremental, and it means the compiled path can ship
before it covers every shape tldraw offers.

## Risks & Open Questions

1. **Text and font fidelity.** The highest risk, and the reason the
   spike below starts here. tldraw measures `autoSize` text against the
   DOM, which is already fragile enough to need `resetTextAutoSize` at
   runtime; baking that measurement at build time could produce text
   that is subtly wrong in a way nobody notices until a talk. Font
   embedding in the exported SVG also needs checking against the decks'
   custom fonts (`XiaolaiSC`, the Excalifont path).
2. **Artifact size.** Baked SVG plus embedded fonts could exceed the
   snapshot JSON it replaces, partly offsetting the bundle win. Needs
   measurement on a large deck (`fig-gradio-lite.json` is 831 KB of
   snapshot).
3. **Dark mode.** `theme-image` resolves light or dark at render time,
   and `useDarkMode()` feeds the current editor. Either bake both
   variants and switch at runtime, or bake per theme.
4. **Asset resolution.** `resolveAssetUrl` in the export context must
   produce URLs that survive into the built deck rather than blob URLs
   scoped to the build process.
5. **Live layer scaling.** Iframes scale by CSS transform, which can
   blur or mis-hit-test at non-integer scales. The current inverse-scale
   plumbing exists partly for this reason and may need a compiled
   equivalent after all.
6. **Behavioural drift.** Tiers 1 and 2 reimplement easing and timing
   that tldraw currently owns. Side-by-side comparison against the
   tldraw runtime should be part of the spike, not an afterthought.

## Spike Plan

Ordered so that the riskiest unknown is answered first, and each step
produces a decision rather than code to keep.

1. **Text and font fidelity (highest risk).** Take
   `202502-oss-pycon-and-me/timeline.json` (33 frames, heavy text) and
   `anipres-and-slidev/fig-webrtc.json`. Bake every shape with
   `getSvgString`, render the result next to a tldraw-rendered
   screenshot at the same size, and diff. **Decision: does baked text
   match, and at what cost in embedded font bytes?** If this fails, the
   whole design needs rethinking, so nothing else should be built first.
2. **Artifact size.** Measure compiled output against snapshot size for
   the largest deck. **Decision: is the bundle win real once fonts are
   embedded?**
3. **One deck end to end.** Compile `202602-oss-give-and-take`
   (9 steps, no embeds, one morph) and play it in a throwaway runtime.
   **Decision: do camera and Tier 2 transitions look right against the
   tldraw original?**
4. **A live layer.** Add an embed-bearing deck and wire YouTube autoplay
   through the IFrame API. **Decision: is the embed story actually
   simpler, as this document claims?**
5. **Tier 3.** Implement crossfade, compare against tldraw on the seven
   `geo` morphs. **Decision: is crossfade good enough, or is option (b)
   needed?**

Only after step 5 is there a case for building the real compiler.

## Out of Scope

- **tldraw v5 upgrade for authoring.** Unblocked by this work but
  independent of it.
- **Changing the data model.** `TimelineDoc` is consumed as-is.
- **Compiling the editor UI.** Authoring stays on tldraw permanently.
- **Server-side or headless rendering** (for example PDF export).
  The compiled scene would be a good input for it, but it is not a goal
  here.
