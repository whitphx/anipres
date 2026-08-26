# Design: Compiled Viewer

> This document specifies a build-time compilation step and a tldraw-free
> playback runtime for `slidev-addon-anipres`. It was produced from a
> follow-up review session on 2026-08-04, from the "Out of Scope /
> Related Future Work" list in
> [`design-animation-data-model.md`](./design-animation-data-model.md).
> The authoring experience is deliberately unchanged: tldraw remains the
> editor, and remains a build-time dependency.

## Status

Proposed. Nothing implemented beyond the throwaway measurements quoted
in [The Execution Environment](#the-execution-environment). The
Animation Data Model v2 work that this design builds on (`TimelineDoc`,
stable `stepId`s) has shipped in `anipres` 0.14.0.

## Revision History

- **r8 (2026-08-06)**: Five findings from a further review, one of
  which corrects r7 itself. r7 claimed a transform animation on a group
  applies its delta to every member layer, "which is what the live
  runtime produces". It is not: `animation.ts` copies only the group
  record, so the temporary shape is an **empty** group, and
  `GroupShapeUtil.component` returns `null` while `onChildrenChange`
  deletes childless groups. Together with `hiddenDuringAnimation` on
  the successor and the `inherit` rule on its members, a group-carried
  `shapeAnimation` draws nothing for its duration today, and the
  compiled runtime reproduces that rather than improving on it, since
  diverging would make a compiled deck differ from the same deck on the
  fallback path. Pre-baked Tier 3 sequences are described honestly as
  **sampled**: each still is exact but the sequence is a step function
  over a continuous tween, so `MorphSequence` carries a `sampleRate`
  and per-still `progress`, exceeding the cap falls back rather than
  coarsening, and the spike asks for a rate rather than a frame count.
  `AnimatedImageLayer` gains `crop`, `flipX`/`flipY`, and the intrinsic
  size, without which a live `<img>` loses the cropping the baked path
  gets from `SvgImage`. `cameraTargets` is collected from every
  `cameraZoom` frame rather than from `slide` shapes, since the model
  does not tie the action to that type. The runtime reconciles layers
  across a theme switch by a stable key, so switching does not reload
  every iframe. `HyperlinkOverlay` ships its own styles instead of
  borrowing tldraw class names the bundle boundary removes.
- **r7 (2026-08-06)**: Ten findings from a workflow-backed review, plus
  a re-measurement of the corpus that corrects this document's own
  numbers. Three of them would have shipped a visibly wrong deck. A
  **group can carry the frame** (33 framed shapes in the corpus are
  groups), so flattening groups away entirely would have left their
  frames matching no layer and painted every grouped diagram from step
  0; layers now record `groupIds`. The **visibility** rule was restated
  as track-only, dropping the guard that hides shapes whose frames are
  detached, which inverts to always-visible. The compile page must
  attach the editor's container to the document, since
  `loadHeadlessEditor` builds a detached one and Chromium gives
  detached subtrees no layout, so **Playwright alone would have
  reproduced the happy-dom text collapse** the browser was chosen to
  fix. r6's Tier 3 default reached the prose but not the schema, so
  `CompiledSceneVariant` gains `morphs`; Tier 2's unconditional
  crossfade is replaced by moving one opaque layer, matching what
  `animation.ts` does, and any `w`/`h` change is now Tier 3 because
  CSS `scale()` scales stroke widths. Animated assets are detected by
  the shape module's `getIsAnimated`, not a mime-type list, since
  tldraw classifies `image/webp` as static and animated WebP is caught
  only by the asset's `isAnimated` flag. `HyperlinkOverlay` mirrors
  `HyperlinkButton`'s corner anchor rather than covering the shape.
  The manifest loses `themes`, because the colour scheme is ambient
  Slidev state rather than a prop and both variants are now always
  baked, and carries font-face descriptors plus a `stepCount` that
  fallback slides need before their runtime loads.
- **r6 (2026-08-06)**: Two fidelity contradictions from an adversarial
  review. Tier 3 now defaults to **pre-baked intermediate frames**
  rather than crossfade: recommending an approximation by default
  contradicted goal 3 and the no-silent-degradation rule, and would have
  visibly changed four authored morphs without asking. Crossfade
  becomes an explicit `approximateMorphs` opt-in. Compilability is
  redefined as a **runtime-semantics capability check** rather than
  "`toSvg` returned non-null", after confirming that both
  `ThemeImageShapeUtil` and tldraw's own `image` shape render a
  `HyperlinkButton` for `props.url` and animate GIF assets, while their
  `toSvg` emits neither: such shapes exported perfectly and lost their
  link and their motion. Adds `AnimatedImageLayer` and
  `HyperlinkOverlay`, a capability table driving fallback, and
  acceptance cases for linked and animated images.
- **r5 (2026-08-06)**: Four findings from a fourth review, one of which
  made r4's variants incorrect. Theme-image shapes must be **adapted**
  per theme before measuring or baking: `toSvg` uses `ctx.isDarkMode`
  only to pick the asset, then renders from the generic `w`/`h`/`crop`,
  which are synchronised from the per-theme props inside a React
  `useEffect` that a headless editor never mounts. Adds a fragment-ID
  namespacing contract, since `SvgImage` emits a `useUniqueSafeId()`
  `clipPath` and the pinned `TLSvgExportOptions` has no
  identifier-prefix hook, so ids must be rewritten after export. `video`
  is reclassified as not-yet-compiled and routes to fallback, rather
  than shipping a descriptor that would reset `time`/`playing` and drop
  `altText`. The compile manifest is keyed by a per-occurrence
  `sceneId` plus `configHash`, because one snapshot can appear in
  components with different fonts, themes, or opt-out.
- **r4 (2026-08-06)**: Four findings from a third review. `CompiledScene`
  gains per-theme `variants`, because `ThemeImageShapeUtil.toSvg` reads
  `ctx.isDarkMode` and resolves a different `assetId`, `dimension`, and
  `crop`, so layers and scene bounds differ per theme and a runtime style
  swap cannot express it. Adds an explicit
  [coordinate contract](#the-coordinate-contract) for independently
  exported layers, after measuring that the markup is already
  page-transformed and padded (an arrow with zero geometric height
  exports 64px tall), so the previous schema would have double-applied
  position and clipped stroke overflow. Infrastructure failures now fail
  the build by default rather than falling back, since a missing browser
  binary would otherwise publish the whole tldraw runtime. The
  artifact-size spike is extended to measure font duplication across
  per-shape exports. Also corrects a stale `LiveLayer.source` reference
  and the claim that `timeline` is enriched; it is unmodified, and the
  additions are sibling fields.
- **r3 (2026-08-04)**: Format gaps closed after a second review.
  `CompiledScene` gains `cameraTargets`, without which `cameraZoom`
  could not execute at all once `slide` shapes are dropped:
  `CameraZoomFrameAction` carries only `inset`/`duration`/`easing`, and
  the live runtime resolves the rectangle by asking the editor for the
  shape's page bounds. The timeline is therefore described as enriched
  rather than verbatim. Live layers become discriminated
  (`EmbedLayer`/`VideoLayer`/`BookmarkLayer`), since a bookmark card is
  rendered from a `TLBookmarkAsset` that a URL-shaped descriptor cannot
  carry. Adds [The Compile Manifest](#the-compile-manifest) for the
  per-component inputs (fonts, theme, opt-out) that live in component
  props rather than in the snapshot. Also fixes two internal
  contradictions: a duplicated fallback section, and an `<img>`
  rendering path that the `foreignObject` risk rules out.
- **r2 (2026-08-04)**: Three review findings resolved. The compiler
  moves into a real browser (Playwright): r1 assumed the Vite plugin
  could bake in-process, but Node has no DOM, and a happy-dom shim was
  measured to run the export while collapsing `autoSize` text and
  embedding no fonts. A [Bundle Boundary](#bundle-boundary) section is
  added, because per-deck fallback does not by itself keep tldraw out
  of the bundle: the fallback must be dynamically imported, elided when
  unused, and asserted absent by a test. `origin` is no longer baked
  into embed URLs, since the page origin is unknown at build time; live
  layers now carry structured parameters and the runtime supplies the
  deployment-sensitive ones.
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
- [The Execution Environment](#the-execution-environment)
- [The Build Pipeline](#the-build-pipeline)
- [The Compile Manifest](#the-compile-manifest)
- [Bundle Boundary](#bundle-boundary)
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
| `group`       | 100   | flattened, but still frameable    |
| `slide`       | 80    | not rendered (camera region only) |
| `image`       | 55    | SVG                               |
| `theme-image` | 12    | SVG (already implements `toSvg`)  |
| `embed`       | 7     | **live DOM**                      |
| `bookmark`    | 4     | **live DOM**                      |
| `note`        | 1     | SVG                               |

Animated transitions, meaning consecutive frames on one track, by what
the transition has to reproduce:

| transition               | count | what changes                        |
| ------------------------ | ----- | ----------------------------------- |
| camera zoom              | 60    | the camera rect only                |
| `geo`, transform only    | 5     | `x`/`y`                             |
| `geo`, prop morph        | 4     | `w`/`h` (4), `fill` (2), `size` (2) |
| `image`, transform only  | 1     | `y`                                 |
| `slide`, renders nothing | 3     | `x`/`y` of a shape kept hidden      |

Two conclusions drive the whole design:

1. **Interactive shapes are never animated.** All 11 `embed` and
   `bookmark` shapes carry no animation frame at all. They are static
   content that appears at a step. So the compiler never has to morph an
   iframe, only position, show, and hide it.
2. **Genuine shape morphing is rare.** Of the 73 animated transitions in
   the corpus, 60 are camera zooms, which are pure arithmetic on bounds.
   Ten of the remaining 13 act on a renderable shape: **six** move it
   without changing a prop, and only **four** are real prop morphs, all
   on `geo` shapes (two change `w`/`h`, two also change `fill` and
   `size`). The other three animate a `slide` shape, which the
   presentation runtime hides, so they render nothing and only spend
   their duration.

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
interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface CompiledScene {
  version: 1;
  /**
   * The derived timeline, UNMODIFIED. Theme does not affect it, and
   * neither does compilation: the extra data the runtime needs lives in
   * sibling fields, never inside `TimelineDoc`.
   */
  timeline: TimelineDoc;
  /**
   * Page-space target rectangle for every `cameraZoom` frame, keyed by
   * the frame's `shapeId`. The live runtime reads this from the `slide`
   * shape via `editor.getShapePageBounds`; the compiled runtime has no
   * shape to ask, and `CameraZoomFrameAction` carries only `inset`,
   * `duration`, and `easing`, so the bounds must be resolved here.
   * Theme-independent, since `slide` bounds do not vary by theme.
   */
  cameraTargets: Record<string, Bounds>;
  /**
   * One fully baked scene per colour scheme. A theme-image shape
   * resolves a different asset AND a different `dimension` and `crop`
   * per theme, so layers and scene bounds genuinely differ; a runtime
   * style swap cannot express it.
   *
   * Total, not `Partial`: the scheme is ambient state the viewer can
   * toggle mid-presentation, so a missing variant has no correct
   * playback behaviour.
   */
  variants: Record<Theme, CompiledSceneVariant>;
}

type Theme = "light" | "dark";

interface CompiledSceneVariant {
  /** Page-space bounds of the whole scene, for the initial camera. */
  bounds: Bounds;
  /** Every renderable shape, in z-order. */
  layers: CompiledLayer[];
  /**
   * Pre-baked tweens for Tier 3 pairs, keyed by the id of the frame
   * whose `shapeAnimation` plays them. A Tier 3 frame with no entry
   * here and no `approximateMorphs` opt-in is a build error, not a
   * silent crossfade.
   */
  morphs: Record<string, MorphSequence>;
}

/**
 * The baked stills of one prop morph, in order. Frame 0 is the
 * predecessor's appearance and the last is the successor's, so the
 * runtime shows exactly one still at a time and never blends two.
 * Each obeys the same coordinate contract as `StaticLayer.svg`, and
 * `exportBounds` is per still because interpolating `w`/`h` moves them.
 *
 * `progress` is the eased position each still was sampled at, in
 * [0, 1]. The runtime shows the still whose `progress` most recently
 * passed, so playback is a step function over a continuous tween
 * rather than a re-derivation of it: the sampling rate, not the
 * format, is what bounds the error.
 */
interface MorphSequence {
  frames: { svg: string; exportBounds: Bounds; progress: number }[];
  padding: number;
  /** Samples per second the sequence was baked at. */
  sampleRate: number;
}

type CompiledLayer =
  | StaticLayer
  | EmbedLayer
  | VideoLayer
  | BookmarkLayer
  | AnimatedImageLayer
  | HyperlinkOverlay;

interface LayerBase {
  shapeId: string;
  /**
   * Ancestor group ids, outermost first. Groups contribute no markup,
   * but a frame can be attached to one, so a frame's `shapeId` matches
   * a layer when it equals `shapeId` OR appears here. Without this the
   * group's frame would match nothing and its members would be treated
   * as unframed. See Groups under Shape Tiers.
   */
  groupIds: string[];
  /**
   * The shape's MODEL transform in page space, groups already
   * flattened. Used to compute animation deltas between keyframes, NOT
   * to place a `StaticLayer` (see `StaticLayer.svg`). Live layers, whose
   * elements the runtime builds itself, do position by this.
   */
  transform: { x: number; y: number; w: number; h: number; rotation: number };
  opacity: number;
}

interface StaticLayer extends LayerBase {
  kind: "svg";
  /**
   * Baked markup from editor.getSvgString([shape]). Rendered INLINE.
   *
   * ALREADY PAGE-TRANSFORMED. Its `viewBox` is in page coordinates and
   * its root `<g>` carries the shape's page transform, so the runtime
   * must NOT position it by `LayerBase.transform`; doing so applies the
   * position twice. See the coordinate contract below.
   */
  svg: string;
  /**
   * The rectangle the `svg` covers, in page space: the shape's page
   * bounds grown by `padding` on every side. This, not `transform`, is
   * where the element goes.
   */
  exportBounds: Bounds;
  /** Padding baked into `exportBounds`, recorded so it is not guessed. */
  padding: number;
}

/**
 * Live layers are discriminated, because a URL alone cannot describe
 * them: a bookmark's card is rendered from asset metadata, and a video
 * needs its poster and playback attributes.
 */
interface EmbedLayer extends LayerBase {
  kind: "embed";
  /**
   * Structured, NOT a frozen URL: deployment-sensitive parameters such
   * as `origin` are unknown at build time and are added by the runtime.
   */
  source: {
    baseUrl: string;
    /** Deployment-independent params, resolved at compile time. */
    params: Record<string, string>;
    /** Params the runtime must supply, e.g. "origin". */
    runtimeParams?: "origin"[];
  };
}

/**
 * NOT COMPILED YET. `video` currently routes to the fallback runtime
 * (see Fallback and Degradation): the corpus contains none, and an
 * approximate descriptor would silently reset playback state. Recorded
 * so the eventual contract matches `TLVideoShapeProps`, which is
 * `{ w, h, time, playing, autoplay, url, assetId, altText }`: `time`
 * and `playing` must survive compilation, and `altText` is an
 * accessibility requirement, while `loop`/`muted` are runtime policy
 * rather than authored state and do not belong here.
 */
interface VideoLayer extends LayerBase {
  kind: "video";
  source: {
    src: string;
    /** Baked frame-0 image, for first paint before the video loads. */
    posterDataUrl?: string;
    time: number;
    playing: boolean;
    autoplay: boolean;
    altText: string;
  };
}

/**
 * An `image`/`theme-image` whose asset is animated. Baking would freeze
 * it at frame zero, which `toSvg` does unconditionally while the
 * component only does it under `prefers-reduced-motion`.
 */
interface AnimatedImageLayer extends LayerBase {
  kind: "animated-image";
  source: {
    src: string;
    /** Frame zero, for first paint and for reduced-motion viewers. */
    posterDataUrl?: string;
    altText: string;
    /**
     * Crop and flip, which the baked path gets for free and this one
     * does not. `toSvg` renders through `SvgImage`, which sizes the
     * image from `getUncroppedSize(dimension, crop)` and clips it;
     * `LayerBase.transform` carries only the visible box, so without
     * these the live `<img>` shows the whole asset unflipped. The
     * runtime reproduces the crop with a clipping wrapper and the flips
     * with a CSS `scale(-1)`, which is exact for a bitmap.
     *
     * For a `theme-image` these come from the theme being baked, since
     * `cropLight` and `cropDark` differ.
     */
    intrinsicSize: { w: number; h: number };
    crop: TLShapeCrop | null;
    flipX: boolean;
    flipY: boolean;
  };
}

/**
 * The affordance a shape's `props.url` produces via `HyperlinkButton`.
 * NOT a transparent hit area over the whole shape: the button is a
 * corner `<a class="tl-hyperlink-button" target="_blank">` carrying a
 * visible link icon, so a shape-sized region would both lose the icon
 * and swallow clicks anywhere on the shape that the author expected to
 * advance the slide.
 *
 * The compiled runtime ships its own copy of the button's geometry and
 * icon. It cannot borrow tldraw's class names, because the bundle
 * boundary removes tldraw's stylesheet from production along with its
 * code, and a class that styles nothing would leave an invisible
 * anchor in an unpredictable place.
 */
interface HyperlinkOverlay extends LayerBase {
  kind: "hyperlink";
  source: { url: string };
  /**
   * Below this scene scale the live button hides itself
   * (`editor.getZoomLevel() < 0.32`). The compiled runtime has no
   * editor, so the threshold is recorded rather than inferred, and the
   * runtime compares it against the Tier 1 camera scale.
   */
  hideBelowScale: number;
}

interface BookmarkLayer extends LayerBase {
  kind: "bookmark";
  /**
   * Copied from the shape's `TLBookmarkAsset`, which the raw snapshot
   * carries and the compiled artifact replaces.
   */
  source: {
    url: string;
    title: string;
    description?: string;
    imageUrl?: string;
    faviconUrl?: string;
  };
}
```

`timeline` is a plain `TimelineDoc`, unchanged by compilation. What the
compiler adds sits beside it: `cameraTargets` carries the one piece of
information the derivation cannot, because `cameraZoom` frames name a
`shapeId` and an `inset` while the live runtime resolves the rectangle
by asking the editor for that `slide` shape's page bounds. Since the
compiler drops `slide` shapes, the rectangle must be resolved at compile
time and stored, or 60 of the corpus's 73 transitions cannot execute.

### The coordinate contract

Per-shape export does not return a shape-sized, origin-relative
picture, and treating it as one is the subtle way to get every layer
slightly wrong. Measured on `fig-webrtc.json`:

| shape | model `x`/`y`  | page bounds                        | svg size        | `viewBox` origin | root `<g>`                        |
| ----- | -------------- | ---------------------------------- | --------------- | ---------------- | --------------------------------- |
| arrow | 180.06, 200.60 | 149.47, 200.60 · 601.69 x **0.00** | 665.69 x 64.00  | 117.47, 168.60   | `matrix(1,0,0,1, 180.06, 200.60)` |
| geo   | 645.00, 80.30  | 645.00, 80.30 · 214.00 x 61.70     | 278.00 x 125.70 | 613.00, 48.30    | `matrix(1,0,0,1, 645.00, 80.30)`  |

Three facts follow, and the contract is built on them:

1. **The `viewBox` is in page coordinates**, offset from the page bounds
   by the export padding (32 per side by default: 149.47 - 32 = 117.47).
2. **The page transform is already inside the markup**, as the root
   `<g>`'s matrix. Placing the SVG at `transform.x`/`y` would apply the
   translation twice.
3. **Visual extent exceeds model bounds.** The arrow's geometric height
   is _zero_, while its export is 64 tall: stroke width and arrowheads
   live entirely in the padding. Sizing a layer box from `transform.w`/`h`
   would clip them.

**Contract.** A `StaticLayer`'s `svg` is treated as already
page-transformed. The runtime positions the element at `exportBounds`,
applies no base transform of its own, and uses `LayerBase.transform`
only to compute _deltas_ for Tier 2 animation, which are applied on top.
`padding` is recorded rather than assumed, because it is an export
option and a future default change would silently shift every layer.

**Unverified: rotation.** No shape in the corpus is rotated, so the
interaction between a non-zero `rotation` and the already-baked matrix
is untested. The spike must cover a rotated arrow, a thick-stroked
shape, and a rotated child inside a group before this contract is
trusted.

Live-layer sources are discriminated for the same reason. A bookmark's
card is not derivable from its URL: the metadata lives in a separate
`TLBookmarkAsset` record. In the corpus, one such asset holds
`{ src, title, description, image, favicon }`, and dropping the snapshot
drops the only copy.

Everything the runtime needs is in this one artifact. It replaces the
`.slidev/anipres/snapshots/*.json` payload in production builds, while
the snapshot remains the authoring source of truth.

### Fragment-ID namespacing

Independently exported layers are inlined into one document, so any
fragment identifier an export defines becomes a document-wide name. This
is not hypothetical in this repo: `SvgImage`, the component
`ThemeImageShapeUtil.toSvg` returns, allocates `useUniqueSafeId()` and
emits `<clipPath id={cropClipId}>` referenced as `url(#cropClipId)`.
`useUniqueSafeId` is built on React's `useId`, which only guarantees
uniqueness within one root; each shape export is its own root, so two
cropped theme images can emit the same id. The second layer's clip path
would then resolve against the first, and the same hazard applies to any
mask, filter, gradient, or marker in a `<defs>` block.

`TLSvgExportOptions` in the pinned 3.15.5 exposes `bounds`, `scale`,
`pixelRatio`, `background`, `padding`, `darkMode`, `preserveAspectRatio`,
and `html`. There is **no** identifier-prefix hook, so prefixing at
export time is not available and the compiler must rewrite after the
fact: for each layer, rename every `id` to a per-layer namespace and
rewrite the matching `url(#...)`, `href="#..."`, `xlink:href`, and any
ARIA id references. The rewrite has to be an allow-listed transformation
over parsed markup rather than a blind string replace, since ids appear
in several attribute grammars.

An acceptance test covers this directly: a scene with two cropped
theme-image shapes plus another `<defs>`-bearing shape, asserting that
every fragment reference resolves within its own layer.

## Shape Tiers

### Compilability is a runtime-semantics question

A shape is compilable when the baked SVG plus its declared live
descriptors reproduce **everything its mounted component does**. A
successful `toSvg` is necessary and nowhere near sufficient, because
`toSvg` is a picture of the shape and the component is the shape's
behaviour. Classifying on "did the export return non-null" would compile
shapes that quietly lose interaction or motion.

This repo demonstrates the gap, and so does tldraw's own `image` shape,
of which the corpus has 55:

- **Hyperlinks.** `ThemeImageShapeUtil`'s component renders
  `<HyperlinkButton url={shape.props.url} />` when `props.url` is set.
  `toSvg` returns only `<SvgImage>`. A linked image would export
  perfectly and stop being clickable.
- **Animated assets.** `toSvg` calls `getFirstFrameOfAnimatedImage` and
  bakes frame zero. The component only does that when
  `usePrefersReducedMotion()` says to, and otherwise shows the moving
  image. A GIF would export perfectly and stop moving.

Neither is hypothetical in the code, though neither is exercised by the
corpus today: no `image` or `theme-image` shape there carries a `url`,
and every asset is `image/png`, `image/svg+xml`, or `image/jpeg`. That
absence is exactly why the rule has to be right rather than
corpus-shaped. It is the content the corpus lacks that the fallback
exists for.

So classification runs a **capability check** per shape, not an export
attempt:

| capability           | detected by                                      | handling                                      |
| -------------------- | ------------------------------------------------ | --------------------------------------------- |
| hyperlink            | `props.url` non-empty                            | live anchor overlay layer above the baked SVG |
| animated asset       | `getIsAnimated(editor, assetId)`, exported       | live `<img>` layer, not baked                 |
| interactive element  | shape type in the live set (`embed`, `bookmark`) | live descriptor, as below                     |
| video                | shape type `video`                               | fallback (not compiled yet)                   |
| unknown shape type   | not in the supported set                         | fallback                                      |
| `toSvg` returns null | export attempt                                   | fallback                                      |

A shape whose capabilities are all covered compiles. A shape with a
capability the compiler cannot preserve sends its deck to fallback. New
tldraw shape types are unsupported until someone audits their component,
which is the safe default rather than an inconvenience.

**Animation is detected by the shape module's own helper, never by a
mime-type list restated here.** `getIsAnimated` is
`MediaHelpers.isAnimatedImageType(mimeType) || asset.props.isAnimated`,
and both halves matter: in the pinned tldraw 3.15.5, `image/webp` is in
`DEFAULT_SUPPORTED_STATIC_IMAGE_TYPES` while `image/avif` is animated,
so an animated WebP is caught only by the boolean asset flag. A
compiler that checked the mime type alone would classify an animated
WebP as static, bake it through `toSvg`, and publish a deck showing a
frozen first frame, which is the exact failure the capability check
exists to prevent. `getIsAnimated` is module-private today, so this
design requires exporting it alongside `applyThemeToShape` below.

**Static shapes** bake through `editor.getSvgString([shape], opts)`,
which accepts a shape subset, so each layer is baked independently
rather than as one page-wide export. Independent baking is what lets
the runtime move and fade layers separately.

**Live shapes** never bake. The compiler records the descriptor and the
runtime creates the element:

- `embed`: an `<iframe>`. The compiler resolves the embed definition and
  the deployment-independent parameters that PR #172 currently injects
  at runtime (`enablejsapi=1`, `mute=1`). `origin` is deliberately left
  to the runtime; see below.
- `video`: **not compiled in the first version.** A `video` shape sends
  its deck to the fallback runtime. The corpus contains none, and
  compiling one against an approximate descriptor would quietly reset
  `time` and `playing` and drop `altText`. The intended contract is
  recorded on `VideoLayer` for when it is implemented.
- `bookmark`: the link preview card. Its metadata lives in a
  `TLBookmarkAsset` record rather than on the shape, so the compiler
  copies the asset's fields into the layer.

**The `slide` shape is not a layer at all.** It is a camera region: the
presentation runtime hides it (`$getShapeVisibilitiesInPresentationMode`
returns `hidden` for it today) and uses only its bounds for
`cameraZoom`. The compiler resolves those bounds into
`CompiledScene.cameraTargets`, keyed by the frame's `shapeId`, and then
drops the shape. Resolving them is mandatory rather than an
optimisation: nothing in `TimelineDoc` can carry a rectangle.

A `slide` shape can nonetheless carry a `shapeAnimation` frame, and
three in the corpus do. The live runtime animates a temporary copy that
is itself a `slide` shape, so the visibility rule hides it too and
nothing appears: the transition spends its `duration` and renders
nothing. The compiled runtime must reproduce that timing rather than
treat the frame as missing, since the step does not advance until it
elapses.

**Theme-image shapes must be adapted before each variant is baked.**
This is the one place where per-theme baking is not just an export
option. `getSvgString` accepts `darkMode`, which sets `ctx.isDarkMode`,
and `ThemeImageShapeUtil.toSvg` uses it to pick the per-theme
`assetId`. But it then renders `<SvgImage shape={shape} />`, and
`SvgImage` reads the **generic** `props.w`, `props.h`, and `props.crop`.
Those generic props are synchronised from `dimensionLight`/`dimensionDark`
and `cropLight`/`cropDark` inside a `useEffect` in the shape's React
component, which a headless editor never mounts.

Left alone, the dark variant would render the dark asset at whatever
dimensions and crop the snapshot happens to carry, which is the last
theme shown while authoring. `getShapePageBounds` reads the same generic
props, so `exportBounds` and the variant's scene `bounds` would be wrong
too. The r4 variants would be internally inconsistent before playback
even starts.

So, for each theme, the compiler adapts every `theme-image` shape before
measuring or exporting:

```ts
props: {
  ...shape.props,
  w: themeProps.dimension.w,
  h: themeProps.dimension.h,
  crop: themeProps.crop,
}
```

applied in a transaction that is rolled back between variants, so the
two bakes do not contaminate each other. The mapping must come from the
shape module rather than being restated in the compiler: `setThemeProps`
is exported today but `getThemeProps` is not, so this design requires
exporting a helper (`applyThemeToShape(shape, theme)`) that the
component's `useEffect` and the compiler both call. Duplicating the
key-selection logic in the compiler would drift silently the first time
a per-theme prop is added.

**Groups** are flattened for rendering but survive as identity. A group
contributes no markup of its own, and its transform is composed into
each descendant layer's page-space `transform`. Eleven framed shapes in
the corpus are nested inside groups, so the flattening is required, not
optional.

Flattening the identity away as well would be wrong, because a group
can carry the frame itself, and in this corpus it usually does: **33
framed shapes are groups**, the third most common framed type after
`slide` (80) and `arrow` (44). `ControlPanel` treats a selected `group`
as frame-attachable whenever no leaf under it has a frame, and
`$getShapeVisibilitiesInPresentationMode` returns `inherit` rather than
`visible` for an unframed shape whose parent is a group, precisely so
the group's own frame drives its members. Drop the group and the
frame's `shapeId` matches no layer: the batch animates nothing, and
every member falls into the unframed-so-always-visible rule, painting
the whole grouped diagram from step 0 in a deck where it was hidden
until its step.

So each layer records its ancestor `groupIds`, and both animation
targeting and visibility resolve a frame's `shapeId` against a layer's
own id or any of its ancestors.

**A `shapeAnimation` whose predecessor or successor is a group renders
nothing while it runs, and the compiled runtime must reproduce that
rather than improve on it.** The temptation is to apply the group's
transform delta to every member layer, which is what the author
presumably wanted. It is not what happens today. `animation.ts` builds
its temporary shape with `createShape({ ...predecessorShape, parentId:
currentPageId, id: animeShapeId })`, and the group's members keep their
`parentId` pointing at the original group, so the copy is an **empty**
group. `GroupShapeUtil.component` returns `null` except when the group
is focused or being erased, and `onChildrenChange` deletes a group that
has no children, so the copy draws nothing either way. Meanwhile
`runStep` sets `hiddenDuringAnimation` on the batch's own shapes, which
hides the successor group and, through the `inherit` rule, its whole
subtree; the predecessor is already hidden by the track rule. The net
effect is a blank gap for the frame's `duration`, after which the
successor subtree appears.

Compiling the delta instead would make a compiled deck play
differently from the same deck on the fallback path, which is a worse
outcome than reproducing an odd behaviour: fallback is supposed to be
the same deck, more slowly. If the blank gap is a bug, it is a bug in
the live runtime, and fixing it there is a separate change this design
should follow rather than pre-empt.

Group frames that only gate visibility are unaffected and compile
normally, which is the common case: a cue frame with no predecessor on
its track performs no animation at all, it just brings the subtree on
at its step.

A Tier 3 morph on a group is not compilable either, since a pre-baked
still of a group is a still of the whole subtree, and it sends the deck
to fallback.

### Why embeds get simpler, not harder

This is worth stating explicitly, because the intuition runs the other
way. PR #172 (`autoplay-youtube`) has to fight tldraw for DOM ownership:
it monkey-patches `DEFAULT_EMBED_DEFINITIONS` to add the IFrame API
parameters, runs a document-wide `MutationObserver` to notice when
tldraw creates an iframe, and recovers the shape id from
`iframe.parentElement.id`. `Anipres.tsx` separately has to enter
tldraw's _editing state_ on click so the user can interact with an embed
during presentation.

In the compiled runtime the iframe is ours. The element reference is
held in a map keyed by `shapeId`, and the YouTube IFrame API is called
directly when the owning step activates. The `MutationObserver`, the id
recovery, and the editing-state hack all disappear, and "autoplay when
the step is reached", which is a `TODO` comment in #172 today, becomes
an ordinary feature of the step runtime.

**Not every embed parameter can be baked.** Deployment-independent ones
(`enablejsapi=1`, `mute=1`) compile fine. `origin` cannot: its value is
the page origin, which is unknown at build time and differs between a
local preview, GitHub Pages, and a custom domain, all of which can be
served from one build. Baking it would produce an iframe whose declared
origin does not match the page controlling the player, breaking the
IFrame API exactly where it is meant to work.

So `EmbedLayer.source` stores structured parts rather than one frozen
URL, and the runtime assembles the final `src` at element-creation time,
adding `origin: window.location.origin` then. Where the origin is opaque
(a sandboxed iframe without `allow-same-origin`, or a `file://` page)
the parameter is omitted rather than sent as `"null"`, and the runtime
falls back to a player without JS API control.

## Animation Tiers

The runtime must reproduce three behaviours that
`presentation-manager/animation.ts` currently delegates to tldraw.

**Tier 1: camera (`cameraZoom`).** Today this is
`editor.zoomToBounds(bounds, { inset, duration, easing })`. Compiled, it
is a CSS transform on the scene container computed from the target
bounds, the viewport size, and `inset`. No shape rendering is involved.
This covers 60 of the corpus's 73 transitions.

**Tier 2: transform-only shape animation.** When consecutive keyframes
differ only in `x`, `y`, and `rotation`, the runtime moves **one** baked
layer from the predecessor's transform to the successor's, using the
frame's `duration` and `easing`, then swaps it for the successor's own
layer at the end. The swap is invisible because a transform-only pair
is geometrically identical at the endpoint.

It must be one layer rather than a crossfade between two. `animation.ts`
creates a single temporary shape from the predecessor and animates it to
the successor's transform, so the moving object is fully opaque
throughout. Two alpha-composited baked copies are not: at the midpoint
of a crossfade each is half transparent, the composite is lighter than
the object ever is, and it visibly ghosts against the slide. That is the
same approximation this document rejects for Tier 3, and it would apply
to the corpus's one pure `x`/`y` `image` move with no opt-in and no
fallback.

Any `w`/`h` change is Tier 3, including a uniform one. CSS `scale()`
scales stroke widths, while tldraw re-renders the shape at the new size
with the stroke width its `size` prop dictates, so a scaled baked layer
is not what the author saw.

**Tier 3: prop morphing.** When props other than the transform change
(`w`/`h`, `fill`, `size`), CSS cannot express the tween, because tldraw
re-renders the shape per frame via `getInterpolatedProps`. Three options,
in increasing fidelity and cost:

- **(a) Crossfade** between the two baked endpoint layers while
  transforming. Cheap, and for a rectangle growing slightly it is close
  to indistinguishable.
- **(b) Pre-baked intermediate frames.** At compile time, lerp the props
  in the editor and bake N intermediate SVGs, then play them as a
  sprite sequence. Every still is exactly what tldraw would have drawn
  at that instant, at the cost of artifact size.
- **(c) Reimplement interpolation** in the runtime for the specific prop
  subset. Highest fidelity, highest maintenance, and it re-imports the
  complexity we are trying to delete.

**Recommendation: (b) is the default. (a) is an opt-in approximation.**

r1 through r5 had this backwards, recommending crossfade by default
because it looks close. That contradicts this document's own contract:
goal 3 is preserving authored behaviour exactly, and the fallback rules
say a compile must never silently produce a lesser deck. A crossfade is
not the authored animation. Where tldraw grows a rectangle by
re-rendering it at interpolated `w`/`h`, a crossfade dissolves the small
one into the large one, and the corpus already contains four pairs that
would visibly change without the author ever being asked.

Pre-baking is also the cheap option here, which is what makes the
default defensible rather than merely principled: four morph pairs
across seventeen decks, at N intermediate bakes each, is a rounding
error against the per-deck browser launch. The cost scales with morph
count rather than deck size, and the artifact-size spike measures it.

**Sampled, not continuous, and the document should not pretend
otherwise.** `editor.animateShape` re-derives the shape from
`getInterpolatedProps` on every tick, so the live tween is continuous
at the display's refresh rate. A sprite sequence matches it only at the
instants it was sampled and repeats a still in between. Each still is
exact, the sequence is a step function over the tween, and the sampling
rate is the whole of the error: at 60 samples per second the step is
one display frame and no viewer can see it, while a coarse cap on a
long morph visibly stutters. So the contract is a **rate**, not a
count, and a cap that would be exceeded routes the pair to fallback
rather than quietly coarsening it. This is the one place where option
(c) would genuinely win, and the trade is deliberate: bytes, which the
spike measures, against re-importing the interpolator.

So:

- **Default**: pre-bake intermediate frames for every Tier 3 pair,
  sampled at `sampleRate` across the frame's `duration` and recorded
  with the eased `progress` of each still. It is carried by
  `CompiledSceneVariant.morphs`, keyed by the frame whose
  `shapeAnimation` plays it, because a `StaticLayer` holds exactly one
  baked picture and has nowhere to put a tween.
- **If the sample count would exceed the cap** (a long morph at a high
  rate), the pair falls back. Dropping the rate instead would ship a
  visibly stepping animation under a default that claims not to
  approximate.
- **Opt-in** (`approximateMorphs: true`, per deck or per frame):
  crossfade instead, for authors who prefer a smaller artifact and
  accept the difference. Such a pair gets no `morphs` entry.
- **If pre-baking a pair fails** (an unbakeable intermediate, say), the
  deck falls back rather than silently degrading to crossfade.
- **A Tier 3 frame with neither a `morphs` entry nor the opt-in is a
  build error.** Without that check the format itself readmits the
  degradation the default exists to prevent: an emitter that skipped the
  sequence would leave the runtime holding two stills and nothing to
  play between them, and its only options would be a jump cut or the
  crossfade this section rejects.

Option (c), reimplementing tldraw's interpolator, remains rejected: it
re-imports the complexity this design exists to delete, and sampling
finely enough is cheap at four morph pairs. If the spike finds the
byte cost unacceptable at a rate viewers cannot distinguish, (c) is the
option to revisit, not a coarser sequence.

### Visibility

Orthogonal to the tiers, and already specified by the derivation. The
compiled runtime computes it from `timeline`, which is a pure function
of the step index, and it is simpler than the current implementation
because there is no `getShapeVisibility` callback to satisfy. But it
must reproduce `$getShapeVisibilitiesInPresentationMode` in full, not
just its track rule:

1. A shape whose frame is in `doc.detachedFrames` is **hidden**. This
   guard comes first, and it is not an edge case invented here:
   `derive.ts` surfaces rule-3 orphans (a sub frame whose `cueFrameId`
   dangles) and never drops them, and the build reports them as the
   `detached-sub-frame` diagnostic. A detached frame belongs to no
   track, so a runtime that knew only the track rule would classify the
   shape as unframed, and therefore always visible, and paint content
   from step 0 that the authored deck never shows.
2. Otherwise, a shape with no interpretable frame is **visible**, except
   that a member of a group inherits, so the group's frame decides.
3. Otherwise, only the last frame of the track's most recently played
   batch is visible; everything else on that track is hidden.

The `slide` shape is absent from `layers` entirely, so its `hidden` case
needs no runtime rule.

## The Runtime

A small Vue component in `slidev-addon-anipres`, replacing the veaury
bridge in production builds:

- Renders `layers` as absolutely positioned elements inside a scene
  container: **inline** `<svg>` for `kind: "svg"`, real elements for live
  layers. Inline is not a preference but a constraint: baked text is HTML
  inside a `<foreignObject>`, which does not render through
  `<img src="...svg">`, so an image-tag path would silently blank every
  text layer.
- Selects the `CompiledSceneVariant` for the current colour scheme,
  watching Slidev's `useDarkMode()` and re-rendering layers on change.
  **Both variants are always compiled**, because the scheme is ambient
  deck state a viewer can toggle mid-presentation, so there is no
  request to honour and no missing-variant case to degrade into. A
  scene reaching the runtime with only one variant is a build error.
- **Reconciles layers across a variant switch by
  `${kind}:${shapeId}`, and preserves any live element whose descriptor
  is unchanged.** Both variants carry the whole `layers` array, so a
  naive re-render would tear down every element, and live elements own
  state the compiled artifact does not describe: recreating an
  `EmbedLayer` reloads its iframe and loses the YouTube player's
  position, and recreating an `AnimatedImageLayer` restarts the
  animation. Most live layers are byte-identical between variants,
  since the theme does not reach an iframe. The exception is a
  `theme-image` whose asset is animated, whose `src`, crop, and
  geometry genuinely differ per theme and which is therefore meant to
  be updated. Hoisting theme-independent live layers out of the variant
  would express this in the schema, but layers interleave with static
  ones in z-order, so keeping one ordered array and reconciling it is
  the simpler correct thing.
- Maps Slidev's click index to a step index, exactly as
  `SlidevAnipres.vue` does today via `calculateTotalSteps`. The count is
  `timeline.steps.length`, a plain array length, so no snapshot parsing
  is involved.
- On step change: applies the camera transform, plays Tier 2/3
  transitions, updates visibility, and notifies live layers (for example
  `player.playVideo()` on a YouTube layer whose step just became
  active).
- Has no editor, no store, no React, and no tldraw import.

The authoring path is unchanged: in dev, `import.meta.hot` is present,
the existing editor mounts, and saving still writes the snapshot JSON.

## The Execution Environment

Baking requires running tldraw's renderer, so the compiler needs a DOM.
A Vite production build runs in Node, where there is none. This section
records what was measured rather than assumed, because the answer
determines whether the rest of the design is reachable at all.

**Constructing the editor in Node is solved.** `loadHeadlessEditor`
calls `document.createElement` directly, so plain Node throws. But
`agent-core` already ships `installDomGlobals()`, which patches a
happy-dom `window`/`document`/`HTMLElement` onto `globalThis` for
exactly this reason, and the agent CLI and MCP server run headless
editing in production on that basis.

**Baking runs under happy-dom, but produces wrong text.** Measured
against `anipres-and-slidev/fig-webrtc.json`:

- `editor.getSvgString([id])` returns real SVG for every shape type in
  the deck (`line`, `geo`, `text`, `arrow`, `slide`), and a whole-page
  bake yields 42,711 characters at 1180.8 x 1032.8.
- A text shape whose stored `props.w` is **149.73** (`autoSize: true`)
  measures **16 x 24** through `getShapePageBounds`, and bakes to an
  80 x 88 SVG. happy-dom has no layout engine, so tldraw's text
  measurement collapses to roughly one character.
- Font embedding silently fails. tldraw fetches its font files to inline
  them, the request goes to `http://localhost:3000/tldraw_draw`, and the
  export continues after logging a `NetworkError`. The output contains
  no `@font-face` and no embedded font data.
- Text is exported as a `<foreignObject>` containing HTML styled with
  `font-family: tldraw_draw`, not as SVG glyph outlines.

So a DOM shim is sufficient to _run_ the export and insufficient to make
it _correct_. Since text is 214 of the 985 shapes in the corpus, and
`autoSize` text is the specific thing that breaks, this rules out the
Node-plus-shim architecture.

**Decision: compile in a real browser.** The compiler drives headless
Chromium through Playwright: load a page, install anipres and the
snapshot, run the bake, and return `CompiledScene` as JSON. Only a real
layout engine measures text the way the authoring editor did, which is
also the only way the baked geometry can match what the author saw.

**A real browser is necessary and not sufficient: the editor's
container must be in the live document.** `loadHeadlessEditor` builds
its container with `document.createElement("div")` and never appends it
to `document.body`. Chromium gives a detached subtree no layout, so
`getBoundingClientRect` and `offsetWidth` return 0 there and tldraw's
text measurement collapses to the same roughly-one-character result
happy-dom produced. Playwright alone would therefore reproduce the
16 x 24 measurement it was chosen to fix, on all 214 text shapes. The
compile page must attach the container to the document and load
tldraw's stylesheet, which the class names `loadHeadlessEditor` already
sets (`tl-container`, `tl-theme__light`) depend on. Since the function
hardcodes a detached container today, this design requires it to accept
one, and the spike's first measurement is what proves the attachment
matters.

Consequences to accept deliberately:

- Playwright becomes a build-time dependency of the addon, with a
  browser download. It must be optional, so that installing the addon
  without ever running a production compile does not pull a browser.
- The Vite plugin **orchestrates** rather than computes: it collects
  snapshots, hands them to the browser-side compiler, and writes the
  results. No tldraw import survives in the plugin's Node context.
- Build time grows by roughly one page load per deck, amortised over
  all its slides.
- CI needs the browser available.

The two rejected alternatives, recorded so they are not re-proposed:
a Node DOM shim (measured above: wrong text), and a tldraw server-side
export API (none exists in the pinned 3.15.5; `getSvgString` is a method
on the browser `Editor`).

## The Build Pipeline

The addon's existing Vite plugin already owns the snapshot lifecycle
(it receives `anipres-snapshot` over the hot channel and serves
snapshots through the `/@slidev-anipres-snapshot` virtual module). The
compiler slots in there, delegating the actual work to the browser:

1. On production build, collect every snapshot plus the compile manifest
   (see [The Compile Manifest](#the-compile-manifest)) and start one
   browser page for the deck. Entries marked `compile: false` are
   skipped and recorded as fallbacks.
2. In the page, for each snapshot: load the manifest entry's font faces
   and tldraw's stylesheet, await `document.fonts.ready` so text
   measures against the real faces rather than a fallback, boot the
   editor with `loadHeadlessEditor` **into a container attached to the
   document**, and derive the timeline with
   `deriveTimeline`. Any diagnostic is a build warning. Once PR #490
   lands, an unconverted deck surfaces as a `v1-frame` diagnostic, which
   should be a build error telling the author to convert the deck;
   before then, 0.14.x still migrates v1 data on load and the case
   cannot arise.
3. Partition shapes into static and live, flatten groups, and resolve
   `cameraTargets` by walking every frame whose action is `cameraZoom`
   and taking its carrying shape's page bounds, before any shape is
   dropped or adapted. Walking the `slide` shapes instead would be
   narrower than the model: `CameraZoomFrameAction` is not restricted
   to `slide`, and the live runtime resolves the rectangle from
   whichever shape holds the frame. The editor only ever attaches one
   to a `slide` (`registerBeforeCreateHandler` in `Anipres.tsx`), and
   all 77 in the corpus are on slides, but a frame that arrived by
   another route would compile to a camera move with no target.
4. Per requested theme: adapt `theme-image` shapes to that theme's
   dimensions and crop, measure bounds, bake static layers with
   `editor.getSvgString({ darkMode })`, namespace each layer's fragment
   ids, and assert that fonts were embedded rather than silently
   skipped. Roll the adaptation back before the next theme.
5. Return `CompiledScene` to Node, emit it, and have the virtual module
   serve it to each component occurrence in place of the raw snapshot.

Dev builds keep serving the snapshot, so authoring is unaffected, no
browser is launched, and the compiler only runs where it pays off.

## The Compile Manifest

The compiler needs inputs the snapshot does not contain. A scene's
rendered appearance also depends on component props that
`SlidevAnipres.vue` applies at mount time, and on ambient state:

- `fontUrls` / `fontUrl`, which override tldraw's font assets.
- `excalidrawLikeFont`, which swaps the draw font.
- The proposed `compile: false` opt-out.

(The light/dark colour scheme is ambient rather than a prop, and is
handled by baking both variants; see below.)

The Vite plugin currently knows only `snapshotId -> JSON file`. Handing
that to the browser compiler would bake text measured against the wrong
faces, which defeats the whole point of compiling in a real browser, and
would leave the build unable to tell whether a component opted out,
which is the precondition for eliding the fallback chunk.

So the plugin emits a manifest alongside the snapshots:

```ts
interface CompileManifestEntry {
  /**
   * Identifies a (snapshot, render-configuration) pair, NOT a snapshot.
   * Two components may share `snapshotId` while differing in fonts or
   * opt-out, and they then need different artifacts.
   */
  sceneId: string;
  snapshotId: string;
  /** Hash over the compile-affecting props; disambiguates `sceneId`. */
  configHash: string;
  compile: boolean;
  /**
   * Every face the compile page must install before measuring, as
   * `@font-face` descriptors rather than a `Record<name, url>`.
   * `fontUrls` alone cannot express the addon's own draw fonts.
   */
  fontFaces: { family: string; src: string; weight?: string }[];
  /** The resolved CSS font stack for tldraw's draw style. */
  drawFontFamily: string;
  /**
   * Step count, derived by the plugin from the snapshot. Present for
   * every entry, INCLUDING `compile: false`, because a fallback slide
   * needs it before its runtime loads.
   */
  stepCount: number;
}
```

**Scene identity is per component occurrence, not per snapshot.** The
component looks its snapshot up by `props.id`, but fonts,
`excalidrawLikeFont`, and `compile` are per instance. Keying the
manifest by `snapshotId` alone would leave three questions unanswered:
which configuration wins, which artifact each occurrence loads, and
whether one `compile: false` forces every occurrence to fall back. So
each occurrence gets a `sceneId` derived from its snapshot plus a
`configHash` over the compile-affecting props, the virtual module maps
occurrence to compiled scene, and identical configurations deduplicate
to one artifact naturally because their hashes match.

**The colour scheme is deliberately not among them.** `SlidevAnipres`
has no theme prop: it reads `const { isDark } = useDarkMode()`, a
deck-global Slidev store, and passes `:colorScheme="isDark ? 'dark' :
'light'"`. There is nothing per occurrence for the SFC parsing below to
read, so a `themes` field would hash a value that does not exist, and
resolving it by baking whatever the deck was authored in would leave a
viewer's dark-mode toggle rendering the light bake (light asset, light
`dimension` and `crop`) inside a dark slide. Both variants are compiled,
always, and the cost folds into the artifact-size spike.

**Font descriptors, not a URL map.** `fontUrls` mirrors tldraw's
`assetUrls.fonts`, which is the wrong shape for the two faces the addon
supplies itself. With `excalidrawLikeFont` set, `drawStyleFontFamily`
resolves to a stack containing Excalifont, declared by a `@font-face`
inside `SlidevAnipres.vue` pointing at `/Excalifont-Regular.woff2`, and
`xiaolaiFont.css.family`, whose file arrives through the virtual id
`/@xiaolai-font.ttf` that the addon's own Vite plugin rewrites to a
subsetted asset. Neither has a slot in a `Record<string, string>` keyed
by tldraw's font names. A compile page given only `drawFontFamily`
would measure `autoSize` text against a fallback face, reintroducing
exactly the mismatch that made a real browser necessary. The plugin
owns that rewrite, so it is the plugin that can resolve the emitted
URLs and hand them to the compile page as faces.

The simpler alternative, which is worth taking if occurrence tracking
proves awkward in the Slidev integration, is to reject a build in which
one `snapshotId` appears with differing compile-affecting configuration,
and tell the author to split it.

**How the manifest is produced** is the open part, and the answer
depends on how the values are written:

- **Static literals** (`<SlidevAnipres id="x" :excalidraw-like-font="true" />`)
  can be read by parsing the slide's SFC at build time. This covers the
  corpus, where the props are literals or absent.
- **Deck-level configuration** (addon options or frontmatter) is
  strictly easier and is the recommended way to express fonts, since
  they are almost always uniform across a deck.
- **Arbitrary Vue expressions** cannot be resolved statically. Such a
  component is marked `compile: false` and falls back, rather than being
  compiled against a guess.

The manifest is therefore also the mechanism by which the build knows
whether every scene compiled, which the next section depends on.

## Bundle Boundary

Goal 1 is not achieved by compiling scenes; it is achieved by there
being no import path from the production entry to tldraw. That is a
property of the module graph, and it has to be designed and then
asserted, because today `SlidevAnipres.vue` statically imports from
`"anipres"` (both the component and `calculateTotalSteps`), which pulls
the editor, React, and veaury into the deck bundle unconditionally.

Rules:

- The production component imports **only** the compiled runtime. It
  must have no static import path to `anipres`'s main entry, React,
  veaury, or tldraw. `calculateTotalSteps` disappears from it entirely,
  since the step count is `timeline.steps.length`.
- **A fallback slide must still know its step count synchronously.**
  Removing the import cannot mean removing the count: the component
  computes `totalStepsCount` before `onMounted` and feeds it to
  `$clicksContext.calculateSince(at, size)`, while a fallback slide has
  no `CompiledScene` and its runtime arrives only after an
  `await import(...)` that resolves later than click registration. Such
  a slide would register zero clicks, and Slidev would advance straight
  past it with none of its steps reachable. The count comes from the
  manifest's `stepCount` instead, which the plugin derives in Node:
  `calculateTotalSteps` reads shape records out of the snapshot JSON and
  needs no editor, so only its module's tldraw imports were ever the
  problem.
- The editor is reached exclusively through `await import(...)`, on two
  paths: the dev-only authoring path (already gated on
  `import.meta.hot`), and the fallback viewer.
- When every scene in a build compiles and no `compile: false` opt-out
  exists, the fallback chunk must not be emitted at all. The compiler
  knows this at build time and can strip the dynamic import through a
  define or a virtual module that resolves to a stub.
- When only some slides fall back, the fallback chunk is fetched lazily,
  when such a slide is first rendered, and is never preloaded. A deck
  with one exotic slide must not pay for tldraw on slide 1.

**Acceptance test.** A build of a fully compiled deck is asserted to
contain no tldraw code, by scanning the emitted chunks for a tldraw
marker and failing the test if it appears. Without that assertion the
goal silently regresses the first time someone adds a convenience
import, which is precisely how the current static import arose.

## Fallback and Degradation

The compiler must never silently produce a lesser deck, and the two
ways a compile can fail are not the same kind of event.

**Unsupported content falls back.** A shape carrying a capability the
compiler cannot preserve (see
[Compilability](#compilability-is-a-runtime-semantics-question)), an
unknown shape type, a `video` shape, a Tier 3 pair whose intermediate
frames cannot be baked, a prop morph on a group, or a static shape whose
`toSvg` returns `null` fails the compile for that deck. The message
names the shape, its type, and the capability that could not be
preserved, and that deck loads the
tldraw runtime dynamically per the boundary rules above. An explicit
`compile: false` behaves the same way. This is what makes adoption
incremental, and it lets the compiled path ship before it covers every
shape tldraw offers.

**Infrastructure failure fails the build.** A missing Chromium, a
browser crash, fonts that do not load, or the font-embedding assertion
tripping are not statements about the deck. Falling back on them means a
machine that merely lacks a browser binary publishes a deck containing
the entire tldraw runtime, which is the exact outcome this work exists
to prevent, announced only by a warning nobody reads in CI output. So:

```ts
/** Addon option. Default "error". */
compileFailure: "error" | "fallback";
```

Infrastructure failures stop a production build unless the author opts
into `"fallback"` deliberately.

**A malformed artifact is a build error, not a degradation.** A Tier 3
frame with neither a `morphs` entry nor the `approximateMorphs` opt-in,
and a scene carrying fewer than both theme variants, are emitter bugs.
Neither may be resolved at playback time by picking the nearest
available thing, because both nearest things (a crossfade, the other
theme's bake) are precisely the silent degradations this section
forbids. The runtime asserts instead.

This distinction matters more than it looks, because installing the
Playwright package does not install a browser: the binary download is a
separate step, and CI images routinely have the library without it. An
optional dependency solves the install-weight problem and not the
execution one, so the default has to be loud.

## Risks & Open Questions

1. **Text and font fidelity.** Still the highest risk, now partly
   characterised (see [Execution Environment](#the-execution-environment)).
   Under a DOM shim it is not a subtle risk but a certain failure:
   `autoSize` text measures 16 x 24 where the author's browser produced
   149.73. Compiling in a real browser is necessary, and the open
   question is whether it is sufficient. `document.fonts.ready` must be
   awaited before measuring, the deck's custom faces (`XiaolaiSC`, the
   Excalifont path) must be loaded in the compile page rather than the
   viewer's, and font embedding must be asserted rather than trusted,
   since the export logs a `NetworkError` and continues when the fetch
   fails.
2. **`foreignObject` text.** tldraw exports rich text as HTML inside a
   `<foreignObject>`, not as glyph outlines. This renders in browsers
   when the SVG is inline, which is what the runtime does, but it means
   compiled layers cannot be dropped into an `<img src="...svg">`, and
   it constrains any later rasterisation or PDF path. It also means the
   runtime must ship the fonts, so removing tldraw does not remove the
   font payload.
3. **Artifact size.** Baked SVG plus embedded fonts could exceed the
   snapshot JSON it replaces, partly offsetting the bundle win. Needs
   measurement on a large deck (`fig-gradio-lite.json` is 831 KB of
   snapshot).
4. **Dark mode.** Resolved in r4 by baking one `CompiledSceneVariant`
   per theme, since `ThemeImageShapeUtil.toSvg` reads `ctx.isDarkMode`
   and selects a per-theme `assetId`, `dimension`, and `crop`, so
   geometry and scene bounds differ and a style swap cannot express it.
   What remains open is cost: two variants roughly double the baked
   payload for decks that use theme images, which folds into the
   artifact-size spike.
5. **Asset resolution.** `resolveAssetUrl` in the export context must
   produce URLs that survive into the built deck rather than blob URLs
   scoped to the build process.
6. **Live layer scaling.** Iframes scale by CSS transform, which can
   blur or mis-hit-test at non-integer scales. The current inverse-scale
   plumbing exists partly for this reason and may need a compiled
   equivalent after all.
7. **Behavioural drift.** Tiers 1 and 2 reimplement easing and timing
   that tldraw currently owns. Side-by-side comparison against the
   tldraw runtime should be part of the spike, not an afterthought.
8. **Capability drift.** The compilability table is a hand-maintained
   mirror of what shape components do. A tldraw upgrade that adds
   behaviour to an existing component (another overlay, a new
   interactive affordance) would not trip any check, and the compiler
   would keep compiling that shape while silently dropping the new
   behaviour. Mitigations worth considering: pinning the tldraw version
   the compiler supports and failing on mismatch, and an audit checklist
   in the upgrade process. This is the structural cost of compiling a
   renderer someone else maintains.
9. **Build-time cost and CI.** Playwright plus a browser download is a
   real tax on `pnpm install` and on CI images. It must be an optional
   dependency that only production compiles require. Note that
   installing the package does not install the browser, so CI needs an
   explicit install step; per
   [Fallback and Degradation](#fallback-and-degradation), its absence
   fails the build by default rather than silently shipping tldraw.

## Spike Plan

Ordered so that the riskiest unknown is answered first, and each step
produces a decision rather than code to keep.

0. **Execution environment (partly done).** Already measured: a
   happy-dom shim runs `getSvgString` but collapses `autoSize` text and
   embeds no fonts, so the remaining question is only whether a
   Playwright-driven Chromium reproduces the authoring browser's
   measurements. Bake `anipres-and-slidev/fig-webrtc.json` there and
   compare the text shape's measured bounds against its stored
   `props.w` of 149.73. Measure it **both** with the editor's container
   attached to the document and with the detached container
   `loadHeadlessEditor` builds today, since the detached case is
   expected to reproduce the happy-dom result in a real browser and
   that expectation is the reason the pipeline attaches it.
   **Decision: does a real browser measure text as the author's editor
   did, and what does attachment cost?** Everything else depends on
   this.
1. **Text and font fidelity (highest risk).** Take
   `202502-oss-pycon-and-me/timeline.json` (33 frames, heavy text) and
   `anipres-and-slidev/fig-webrtc.json`. Bake every shape in the browser
   environment from step 0, render the result next to a tldraw-rendered
   screenshot at the same size, and diff. **Decision: does baked text
   match visually, and at what cost in embedded font bytes?**
2. **Artifact size, and font duplication in particular.** tldraw's
   export is self-contained: it inlines the fonts the exported content
   needs. Per-shape export therefore risks embedding the same face once
   per text layer, and the corpus has 214 text shapes. The scale is not
   hypothetical, since the addon's own draw font
   (`XiaolaiSC-Regular.ttf`) is 22 MB before the build's subsetting
   pass. This could not be measured in the happy-dom probe because the
   font fetch failed there, so it is genuinely open. Report, for the
   largest deck: total embedded font bytes, unique bytes after
   deduplication, repeated bytes across layers, and output size with
   fonts hoisted to scene or deck level. **Decision: is the bundle win
   real, and must fonts be shared rather than embedded?** The likely
   answer is shared scene-level font CSS or emitted font assets, with
   layer SVGs referring to them, which would change `StaticLayer`.
3. **The coordinate contract under rotation, and fragment ids.** Author
   a scratch deck with a rotated arrow, a thick-stroked shape, a rotated
   child inside a group, and two cropped theme images. Verify that
   positioning each layer at `exportBounds` reproduces the tldraw
   rendering pixel for pixel, and that both clip paths survive being
   inlined into one document. **Decisions: does the
   already-page-transformed contract hold when `rotation` is non-zero,
   and does id namespacing hold?** Tier 2 has no well-defined endpoints
   until the first does.
   In the same deck, attach a cue frame to a **group** and leave its
   members unframed, and include a shape whose sub frame is detached.
   **Decision: do `groupIds` and the detached-frame rule reproduce
   `$getShapeVisibilitiesInPresentationMode` step for step?** Both are
   visibility rules a track-only runtime silently inverts, turning
   hidden content visible, and 33 framed shapes in the corpus are
   groups. Add a second batch on the group's track so a group-to-group
   `shapeAnimation` actually runs, and record on video what the live
   runtime draws during it. **Decision: is the blank gap this document
   predicts what actually happens?** The compiled behaviour is
   specified from that answer, not from what the animation ought to
   look like.
4. **Theme-image variant correctness, and the capability rule.** Give a
   theme image deliberately different `dimensionLight`/`dimensionDark`
   **and** `cropLight`/`cropDark`, not just different assets, then bake
   both variants headlessly. In the same scratch deck, include a linked
   `image`, a linked `theme-image`, an animated GIF `image`, an animated
   `theme-image`, and an **animated WebP**, whose mime type tldraw
   classifies as static so that only the asset's `isAnimated` flag
   catches it. Give one animated image a crop and a `flipX`, and toggle
   dark mode mid-playback with an embed on screen. **Decisions: does
   the theme adaptation reproduce what the mounted component's
   `useEffect` produces, does every shape retain its click target and
   its motion, does the live `<img>` reproduce the crop and flip the
   baked path would have got for free, and does the iframe survive the
   theme switch without reloading?** The linked and
   animated cases must either survive as live layers or send the deck to
   fallback; compiling them into a still picture is the failure this
   step exists to catch.
5. **One deck end to end.** Compile `202602-oss-give-and-take`
   (9 steps, no embeds, one morph) and play it in a throwaway runtime.
   **Decision: do camera and Tier 2 transitions look right against the
   tldraw original?**
6. **A live layer.** Add an embed-bearing deck and wire YouTube autoplay
   through the IFrame API. **Decision: is the embed story actually
   simpler, as this document claims?**
7. **Tier 3.** Implement pre-baked intermediate frames and compare
   against tldraw on the corpus's four `geo` morphs, recording each
   still's eased `progress` and playing the sequence as a step
   function. Sweep the sample rate and find where the stepping stops
   being visible against the live tween.
   **Decisions: what sample rate is indistinguishable from
   `getInterpolatedProps` at the display's refresh rate, what does that
   rate cost in bytes, and is the opt-in crossfade close enough to be
   worth offering at all?** Note this is a rate question, not a frame
   count: a fixed count stutters on long morphs and wastes bytes on
   short ones.

Only after step 7 is there a case for building the real compiler.

## Out of Scope

- **tldraw v5 upgrade for authoring.** Unblocked by this work but
  independent of it.
- **Changing the data model.** `TimelineDoc` is consumed as-is.
- **Compiling the editor UI.** Authoring stays on tldraw permanently.
- **Server-side or headless rendering** (for example PDF export).
  The compiled scene would be a good input for it, but it is not a goal
  here.
