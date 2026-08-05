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
   */
  variants: Partial<Record<Theme, CompiledSceneVariant>>;
}

type Theme = "light" | "dark";

interface CompiledSceneVariant {
  /** Page-space bounds of the whole scene, for the initial camera. */
  bounds: Bounds;
  /** Every renderable shape, in z-order. */
  layers: CompiledLayer[];
}

type CompiledLayer = StaticLayer | EmbedLayer | VideoLayer | BookmarkLayer;

interface LayerBase {
  shapeId: string;
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

interface VideoLayer extends LayerBase {
  kind: "video";
  source: {
    src: string;
    /** Baked frame-0 image, for first paint before the video loads. */
    posterDataUrl?: string;
    autoplay: boolean;
    loop: boolean;
    muted: boolean;
  };
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
time and stored, or 62 of the corpus's 70 morph pairs cannot execute.

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

## Shape Tiers

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
- `video`: a `<video>` element, carrying its playback attributes plus
  the poster frame baked for first paint (which is all
  `VideoShapeUtil.toSvg` would have given us anyway).
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
  container: **inline** `<svg>` for `kind: "svg"`, real elements for live
  layers. Inline is not a preference but a constraint: baked text is HTML
  inside a `<foreignObject>`, which does not render through
  `<img src="...svg">`, so an image-tag path would silently blank every
  text layer.
- Selects the `CompiledSceneVariant` for the current colour scheme,
  watching Slidev's `useDarkMode()` and re-rendering layers on change.
  If the requested theme was not compiled, it falls back to the one that
  was, since a stale-but-correct scene beats a blank one; the manifest's
  `themes` is what decides which exist.
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
2. In the page, for each snapshot: load the manifest entry's fonts,
   await `document.fonts.ready` so text measures against the real faces
   rather than a fallback, boot the editor with `loadHeadlessEditor`,
   and derive the timeline with
   `deriveTimeline`. Any diagnostic is a build warning. Once PR #490
   lands, an unconverted deck surfaces as a `v1-frame` diagnostic, which
   should be a build error telling the author to convert the deck;
   before then, 0.14.x still migrates v1 data on load and the case
   cannot arise.
3. Partition shapes into static and live, flatten groups, resolve
   `cameraTargets` from the `slide` shapes before dropping them, bake
   static layers with `editor.getSvgString`, and assert that fonts were
   embedded rather than silently skipped.
4. Return `CompiledScene` to Node, emit it, and have the virtual module
   serve it instead of the raw snapshot.

Dev builds keep serving the snapshot, so authoring is unaffected, no
browser is launched, and the compiler only runs where it pays off.

## The Compile Manifest

The compiler needs inputs the snapshot does not contain. A scene's
rendered appearance also depends on component props that
`SlidevAnipres.vue` applies at mount time, and on ambient state:

- `fontUrls` / `fontUrl`, which override tldraw's font assets.
- `excalidrawLikeFont`, which swaps the draw font.
- The light/dark colour scheme, read from `useDarkMode()`.
- The proposed `compile: false` opt-out.

The Vite plugin currently knows only `snapshotId -> JSON file`. Handing
that to the browser compiler would bake text measured against the wrong
faces, which defeats the whole point of compiling in a real browser, and
would leave the build unable to tell whether a component opted out,
which is the precondition for eliding the fallback chunk.

So the plugin emits a manifest alongside the snapshots:

```ts
interface CompileManifestEntry {
  snapshotId: string;
  compile: boolean;
  /** Resolved absolute URLs, so the compile page loads the same faces. */
  fontUrls: Record<string, string>;
  drawFontFamily: string;
  /** Which colour schemes to bake; see the dark-mode risk. */
  themes: ("light" | "dark")[];
}
```

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

**Unsupported content falls back.** An unknown shape type, or a static
shape whose `toSvg` returns `null`, fails the compile for that deck with
a message naming the shape and type, and that deck loads the tldraw
runtime dynamically per the boundary rules above. An explicit
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
8. **Build-time cost and CI.** Playwright plus a browser download is a
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
   `props.w` of 149.73. **Decision: does a real browser measure text
   as the author's editor did?** Everything else depends on this.
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
3. **The coordinate contract under rotation.** Author a scratch deck
   with a rotated arrow, a thick-stroked shape, and a rotated child
   inside a group, then verify that positioning each layer at
   `exportBounds` reproduces the tldraw rendering pixel for pixel.
   **Decision: does the already-page-transformed contract hold when
   `rotation` is non-zero?** Tier 2 has no well-defined endpoints until
   it does.
4. **One deck end to end.** Compile `202602-oss-give-and-take`
   (9 steps, no embeds, one morph) and play it in a throwaway runtime.
   **Decision: do camera and Tier 2 transitions look right against the
   tldraw original?**
5. **A live layer.** Add an embed-bearing deck and wire YouTube autoplay
   through the IFrame API. **Decision: is the embed story actually
   simpler, as this document claims?**
6. **Tier 3.** Implement crossfade, compare against tldraw on the seven
   `geo` morphs. **Decision: is crossfade good enough, or is option (b)
   needed?**

Only after step 6 is there a case for building the real compiler.

## Out of Scope

- **tldraw v5 upgrade for authoring.** Unblocked by this work but
  independent of it.
- **Changing the data model.** `TimelineDoc` is consumed as-is.
- **Compiling the editor UI.** Authoring stays on tldraw permanently.
- **Server-side or headless rendering** (for example PDF export).
  The compiled scene would be a good input for it, but it is not a goal
  here.
