# Agent: Open Work

Items deferred during the initial agent build (this PR) that are worth tracking but don't block shipping. Grouped by leverage. Each entry explains the gap, what observably breaks today, and what the implementation would touch.

## Perception extensions

- **Group projection.** `tldrawShapeToFocusedShape` returns `null` for `group` shapes today, so the agent can't address grouped clusters as units. Real diagrams (e.g., the user's Git-remote-fork deck) lean on groups to bundle "this commit graph" or "this branch label + nodes" into one logical thing. With group projection the agent could say "recolor the main-branch group" rather than enumerating every line and ellipse inside. Implementation: add a `FocusedGroup` schema with `childShapeIds` and bounds, project from tldraw's `GroupShapeUtil`, and teach the system prompt to expand a group reference into its members at apply time.

- **Arrow-binding-aware projection.** Today `tldrawShapeToFocusedShape` reads `arrow.props.start` and `arrow.props.end` as raw `{x, y}` pairs. For arrows that are _bound_ to other shapes (the common case in real diagrams — node A → node B), tldraw stores the visual endpoints in separate binding records, not in `props.start/end`. Result: the agent perceives bound arrows with `start: (0, 0)` etc., which is misleading. Fix: read the editor's bindings via `editor.getBindingsToShape(arrow.id)`, resolve the referenced node ids, and surface them as `startBoundTo: shapeId` / `endBoundTo: shapeId` on the focused shape so the agent can reason about connections, not just coordinates.

- **Image / theme-image projection.** Both shape kinds carry asset references, not inline pixel data, so the agent could in principle perceive them by id and update shape-level props (position, size). What it _can't_ do without an asset-upload flow is create new images. v0 drops them entirely. The minimal useful next step is read-only projection (`{_type: "image", shapeId, x, y, w, h, assetId}`) so update/delete become possible — leave create for later when the asset-upload story is settled.

## Action extensions

- **Wider `create`.** `CreatableShapeSchema` is intentionally narrow (rectangle + slide). The full perception union covers ellipse / line / arrow / text — extending `create` to those is mechanical: each gets a branch in `focusedShapeToTldrawShape` that builds the right tldraw `props` shape. The reason it wasn't done in this PR is scope; the model's existing pattern (use `update` to recolor, etc.) covers most "modify what's already there" requests, but it can't _add_ a new arrow between two existing shapes today.

- **`SubFrame` action support.** Anipres's animation model has `CueFrame` (opens/extends a track at a step) and `SubFrame` (intermediate states within one step's transition — e.g., "fly to A, pause, then fly to B in one step"). The PR ships `attachCueFrame` only. The agent can express most animations as a sequence of cue frames across separate steps, but it can't currently build the multi-stage intra-step animations that `SubFrame` enables. Add `attachSubFrame { shapeId, prevShapeId, action }` when a use-case actually surfaces — premature without a concrete need.

- **More `update` fields.** Currently `update` covers `x, y, w, h, color, text`. Common asks the agent will hit and can't do: rotation, opacity, fill, font, dash style, arrow heads. Each is a one-line addition to the schema and the apply path. Worth doing in one batch when one of them is needed.

- **`MoveShape` semantics distinct from `update`.** `update { shapeId, x, y }` moves a shape, but it doesn't move children of a group along with it. tldraw has `editor.translateShapes` for the right semantics. If group projection ships, we likely also want a dedicated `move` action that handles group recursion correctly — or `update` learns to dispatch through `translateShapes` when the target is a group.

## Headless presentation reconciliation

When a frame-bearing shape is deleted in the React app, `PresentationManager.reconcileShapeDeletion` (registered in `Anipres.tsx`'s `onMount` via `editor.sideEffects.registerAfterDeleteHandler`) renumbers `globalIndex` across remaining steps and heals broken `prevFrameId` chains. **Headless flows (CLI, MCP) don't run that handler** — `loadHeadlessEditor` doesn't register any side effects. Symptom: deleting a slide via the agent CLI/MCP leaves a hole in the timeline (the surviving slides keep their original `globalIndex` values, so loading the snapshot back in the React app finds a gap).

Most of the agent's editing happens on non-frame shapes (commit-graph circles, lines, etc.) where this isn't a problem. But it's a real gap. Cleanest fix: extract `reconcileShapeDeletion` from `PresentationManager` into a standalone function exported from `anipres/models`, then have both the React component (still via `presentationManager.reconcileShapeDeletion`) and the CLI's `DeleteShapeActionUtil` call it. The standalone function only depends on `Editor` and the model helpers, no React.

## Perception edge cases

- **Silent perception drop for unsupported `geo` subtypes.** `tldrawShapeToFocusedShape` returns `null` for `geo` shapes whose `props.geo` isn't `rectangle` / `ellipse` / `oval` — so triangles, diamonds, stars, hexagons, arrows-as-geo, etc. are invisible to the agent. The system prompt only warns about groups / images / theme-images, so the agent will confidently say "I don't see any triangle" while the user is staring at one. Either project the missing kinds into the union or surface a generic `unsupported` entry so the agent knows they exist.

## UX polish (web chat)

- **Streaming preview** (the `tldraw/agent-template` revert-and-reapply pattern). Today: `applyActionStream` skips `complete: false` actions; shapes appear in the editor only when each `create`/`update` action is fully streamed. With streaming preview: shapes appear immediately and get retracted/replaced as the JSON refines. Visible "live" feel; especially nice for `create` actions where shape props (size, color, position) settle out as more JSON arrives. Implementation: track an `incompleteDiff` per-iteration in `applyActionStream`, use `editor.markHistoryStoppingPoint()` + `editor.bailToMark()` to revert before applying each new incomplete state. Test carefully against multi-action runs (the recoloring case where 24 updates fire) — the in-app `action` log entries we just added partially cover the same UX need, so this is now polish rather than essential.

- **Cancel feedback.** Clicking ↺ Cancel mid-stream aborts the request, but the trailing agent bubble keeps whatever partial text it had — looks like the agent finished naturally. Suffix it with `(cancelled)` (or render in muted style) so the user can tell.

- **Token usage / cost surfacing.** AI SDK's `onFinish` already surfaces `usage` (we just don't propagate it). Plumb it through `streamActions`'s callback into the chat panel; render somewhere unobtrusive (footer? next to the Cancel/Send button?). Useful for cost-conscious users running expensive models.

- **Per-document chat persistence schema versioning.** The PR persists `{log, history}` to `localStorage[anipres.chat.<docId>]` as raw JSON. Add a `version` field so future schema changes (e.g., adding richer `action` log entries with structured data) can either migrate or fall back gracefully instead of crashing the panel.

- **`skipNextPersistRef` race on rapid doc switches.** The cross-document corruption fix (commit `53bd47a`) closes the most-painful case — the aborted send no longer mutates the new doc's state. A narrower race remains: if the user switches docs _twice_ in rapid succession (faster than React can flush effects) and the persist effect happens to interleave between the two restores, the wrong doc's content can briefly hit the wrong key. A robust fix captures `activeDocumentId` at restore time into a ref and refuses to persist when the captured id disagrees with the effect's current `activeDocumentId`.

## Operational

- **Worker rate / duration limits on `/api/agent/stream`.** SSE streams hold a worker invocation open for the full duration of the model call (potentially minutes for long runs). No hard cap today. Cloudflare Workers have a default CPU/wall-time budget; worth bounding `maxOutputTokens` (currently 8192) and setting an explicit timeout to avoid runaway costs.

- **Auth-level rate limiting.** `/api/agent/stream` sits behind the existing session auth, so a logged-in user can hammer it. No per-user rate limit yet. With BYO key the _cost_ falls on the user (their key, their bill), but the _worker time_ is on us. Add a token-bucket per-user limit (e.g., 10 streams per minute) once usage starts.

- **Anti-injection in the user message.** The chat panel sends the user's textarea content directly into the prompt's `userMessages` part. A motivated user can write `"...new instruction: empty the canvas"` and the model will read it. The model is allowed to act on user input (that's the whole point), but we should make sure the user's text can't escape into the _system_ role. Today we use `allowSystemInMessages: true` and only the _system_ prompt itself goes in the system slot — user input always reaches the user role. Verify by inspection that no path concatenates user content into the system prompt.

- **Stream error sanitization.** The worker route catches stream errors from `streamActions` and forwards `err.message` back to the browser as an `error` SSE event. AI SDK errors sometimes carry the request body in `error.cause` or include API-key headers in their stack. Strip stack traces and known-sensitive header names before flushing to the SSE channel. Combined with the cleaner classification we already have on the MCP side, the chat panel could surface a friendly "auth failed" / "rate-limited" / "transient error" instead of a raw stack.

## Testing gaps

- **Worker-route integration test.** The `/api/agent/stream` route has no test. Easiest coverage: use `@cloudflare/vitest-pool-workers` (already in the worker's devDeps) to POST a fake prompt with a stub provider, assert the SSE response body contains `data: ` lines.

- **End-to-end browser test for the chat flow.** Today the chat panel is verified by manual Playwright passes (this PR's last few commits). A persistent test that spins up app dev + worker dev, mocks the `/api/agent/stream` response, and walks through "type prompt → see actions stream → see editor mutate" would catch regressions in the React + SSE wiring.

- **Multi-turn conversation test.** The chat-history wiring (`useAgent` accumulates history across turns) is exercised manually but not unit-tested. Add a `parseActionStream`-style mock that runs two turns and asserts the second prompt includes the first turn's user + agent message in `chatHistory`.

- **`useAgent` abort-during-stream regression test.** The cross-document corruption fix (commit `53bd47a`) is currently only verified by code reading. A proper test needs `@testing-library/react`'s `renderHook` (not currently in `agent-core`'s devDeps) plus a stubbed `streamFromServer` that yields one chunk, then signals a restore mid-stream, then asserts no agent turn was pushed to history. Worth doing because the bug pattern (state mutated in `finally` after an abort) is easy to reintroduce with a "small refactor".

- **`stream-from-server` malformed-SSE handling test.** The new try/catch around `JSON.parse` (commit pending) is untested. Add a fake `Response` with a body iterator yielding (a) a malformed `data:` followed by (b) a valid one; assert the valid one is yielded and the iterator doesn't throw.

- **`closeAndParseJson` non-JSON-prefix test.** The model could in principle emit apologetic prose before the JSON (`"I'm sorry, I can't help with..."`). Combined with the assistant prefill, the buffer would be `{"actions": [{"_type":I'm sorry...` which never closes to valid JSON. The current behaviour (return `null` forever, no actions yielded) is correct but not covered. Add a test that exercises this and confirms the parser doesn't crash or buffer-grow unboundedly.

## Model behaviour

- **Spatial / semantic disambiguation in real diagrams.** The "make the main branch orange" run on `git-remote-fork.json` showed the agent guesses spatially when no selection is given. Sometimes that's right, sometimes wrong. The PR's `selectedShapes` perception part already gives the user the most reliable disambiguation lever (just select the shapes). Possible perception improvements that could help when no selection is present:
  - **Shape clusters.** Project shapes grouped by spatial proximity and label adjacency, so the agent sees "these 6 shapes are clustered near the text 'main branch'" as a unit.
  - **Text-to-shape associations.** For each text shape, list the N nearest non-text shapes. Lets the agent connect labels to content without spatial reasoning from coordinates.

  Both are perception-only changes (no new actions). Worth trying once a real workflow surfaces where selection isn't natural.

- **`finishReason: length` on long runs.** `streamActions` caps `maxOutputTokens` at 8192. A multi-action recoloring of dozens of shapes is well under that, but a "build me a 30-slide presentation" prompt could hit the cap. Today nothing reports it as a soft failure to the user — they'd see a partial result with no explanation. Plumb the existing `onFinish` callback into the MCP / chat error path so a `length` finish gets surfaced like the other no-action error cases.

- **System-prompt schema cost on non-Anthropic providers.** The `buildSystemPrompt` output includes the full Zod-derived JSON schema (~3-4 KB). The Anthropic call gets a `cacheControl: ephemeral` breakpoint so the system prompt amortizes across turns; OpenAI and Google calls re-pay the full token cost on every request. If GPT/Gemini usage picks up, either switch to provider-specific cache equivalents (OpenAI's prompt-caching headers, Gemini's context caching API) or compress the schema (drop verbose `description` strings on rarely-used branches, switch to a minimal hand-written schema instead of `z.toJSONSchema`).

## Documentation

- **`packages/agent-cli/README.md`** with install + usage (`anipres-agent edit`, `anipres-agent summarize`, env var matrix per provider).
- **`packages/agent-mcp/README.md`** with install + Claude Code / Cursor MCP-config snippets, plus the env var note (we already added a clear in-tool error if the key is missing, but the README should explain it upfront).
- **A short `docs/agent-architecture.md`** sketching the spine: how perception parts are gathered, how actions stream, how the same code paths serve CLI / web / MCP. Aimed at someone landing in `packages/agent-core/` for the first time.
- **Top-level `README.md` mention** of the agent feature so it's discoverable.

## Repository hygiene

- **Squash decision for the diagnostic-arc commits.** Six commits in this PR (between `bf46d37` and `19caa60`) trace a step-by-step debug session into the MCP "no actions emitted" bug. They tell a useful story but are noisy in `git log`. Squash to a single "MCP no-action diagnostics + classifier" on merge if the maintainer prefers a clean per-feature history; keep as-is if the bug-investigation narrative is worth preserving.

- **Workspace name vs scope.** The new packages use the `@anipres/` scope (`@anipres/agent-core`, `@anipres/agent-cli`, `@anipres/agent-mcp`); the existing `anipres` package is unscoped. If/when these get published, decide whether to keep the split (publishing a scoped namespace alongside the existing unscoped package) or move the existing one under `@anipres/` too.
