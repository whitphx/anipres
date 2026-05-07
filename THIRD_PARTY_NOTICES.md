# Third-party notices

Anipres is MIT-licensed (see `LICENSE`). The agent feature draws
significant inspiration from the third-party project listed below —
in design, structure, naming, and several specific patterns. We owe
that work a real intellectual debt; this notice exists both to thank
the upstream authors and to satisfy the attribution requirements of
their license.

---

## tldraw/agent-template

Source: https://github.com/tldraw/agent-template
License: MIT

```
MIT License

Copyright (c) 2024 tldraw Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
of the Software, and to permit persons to whom the Software is furnished to do
so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### What we owe the upstream

The list below is calibrated by how directly the borrowing happens —
"largely a port" for files that follow upstream code closely, "the
design is theirs" for shape-and-naming-but-rewritten-implementation,
"informed by" for the lighter conceptual inheritance. The intent is to
credit the upstream work honestly, not to limit our obligation:

- **`closeAndParseJson` partial-JSON parser** — `packages/agent-core/src/server/close-and-parse-json.ts`
  is **largely a port of** [`worker/do/closeAndParseJson.ts`](https://github.com/tldraw/agent-template/blob/main/worker/do/closeAndParseJson.ts)
  — same algorithm, same stack representation (`{`, `[`, `"`),
  same JSON.parse-or-null contract. The version here is in
  TypeScript, uses a for-loop instead of while+i++, and adds a fix
  for an escape-detection bug (counting consecutive backslashes
  rather than checking the immediately-previous character). The
  technique itself is upstream's.
- **JSON-action streaming protocol** — `packages/agent-core/src/server/stream-actions.ts`'s
  shape (assistant prefill of the opening `{"actions":[{"_type":`,
  cursor-driven partial-JSON parsing, yielding each action twice
  with `complete: false` then `complete: true`) **comes from
  upstream**. The implementation here threads the design through
  the Vercel `ai` SDK and adds Anipres-specific bits (provider
  switching, the abort-signal forwarding, the multi-action-per-chunk
  cursor fix), but the protocol itself is theirs.
- **`Streaming<T>` type** — `packages/agent-core/src/types/streaming.ts` —
  the name and the "wrap any T with a `complete` boolean (and a
  `time` field) so consumers can distinguish in-flight from
  completed values" concept **come from upstream's**
  [`shared/types/Streaming.ts`](https://github.com/tldraw/agent-template/blob/main/shared/types/Streaming.ts).
  Their version is a discriminated union (`Partial<T> & { complete:
false } | T & { complete: true }`); mine is a flat shape with a
  boolean discriminator. Same protocol, simpler type.
- **`buildMessages` prompt → ModelMessage assembly** — `packages/agent-core/src/server/build-messages.ts`'s
  function name, signature (`(prompt: AgentPrompt) => ModelMessage[]`),
  and role **come from upstream's**
  [`worker/prompt/buildMessages.ts`](https://github.com/tldraw/agent-template/blob/main/worker/prompt/buildMessages.ts).
  My body is a hard-coded sequence over the known parts; upstream
  composes per-part `buildContent` / `buildMessages` callbacks with
  a priority sort. Same load-bearing design, simpler implementation.
- **`buildResponseSchema` JSON-Schema export** — `packages/agent-core/src/schemas/build-response-schema.ts`'s
  function name and core pattern (build a Zod schema with `{ actions:
z.array(actionSchema) }` then call `z.toJSONSchema(...)`) **come
  from upstream's**
  [`shared/schema/buildResponseSchema.ts`](https://github.com/tldraw/agent-template/blob/main/shared/schema/buildResponseSchema.ts).
  Upstream additionally accepts `actionTypes`/`mode` arguments and
  strips internal meta keys; Anipres has neither yet.
- **Tldraw → focused-shape projection** — `packages/agent-core/src/format/convert-tldraw-shape-to-focused-shape.ts`'s
  `tldrawShapeToFocusedShape` function (name, role, switch-on-
  `shape.type` structure, returns a discriminated union of
  `_type`-tagged simplified shapes) **comes from upstream's**
  [`shared/format/convertTldrawShapeToFocusedShape.ts`](https://github.com/tldraw/agent-template/blob/main/shared/format/convertTldrawShapeToFocusedShape.ts).
  The Anipres set of focused shapes is smaller and adds a `slide`
  kind; the inverse direction (`focusedShapeToTldrawShape`, with
  the cameraZoom auto-cue handling for slides) lives in
  `packages/agent-core/src/client/convert-shape.ts` and is original.
- **`format/` directory layout** — the split between `format/`
  (visual-primitive schemas: focused color / easing / frame action
  / shape, plus the tldraw-shape projection) and `schemas/` (the
  agent-facing schemas: action, prompt-part, response-schema)
  **mirrors upstream's** `shared/format/` vs `shared/schema/` split.
  Going file-by-file (rather than collapsing into one `actions.ts`
  god-file) makes future syncing against upstream changes easier.
- **System-prompt scaffolding** — `packages/agent-core/src/server/build-system-prompt.ts`
  takes the section structure (intro + rules with `###` sub-sections),
  the JSON-actions self-description, the "always emit at least one
  action" rule, and the user-selection disambiguation idiom ("when
  the user says 'this' / 'these', prefer the selection") **directly
  from upstream's**
  [`intro-section.ts`](https://github.com/tldraw/agent-template/blob/main/worker/prompt/sections/intro-section.ts)
  and
  [`rules-section.ts`](https://github.com/tldraw/agent-template/blob/main/worker/prompt/sections/rules-section.ts).
  The body of each section is rewritten for Anipres' vocabulary
  (slides, cue frames, tracks, steps, the worked example), but the
  scaffolding and several phrasings are clearly indebted to upstream.
- **`AgentHelpers` shape-id resolution** — `packages/agent-core/src/client/agent-helpers.ts`'s
  class name, role (per-request agent-id ↔ tldraw-id mapping with
  collision avoidance), `Map<string, ...>` data structure, and
  resolution flow ("look up first, mint a new one if missing")
  **come from upstream's**
  [`AgentHelpers.ts`](https://github.com/tldraw/agent-template/blob/main/client/AgentHelpers.ts).
  The version here is a simplified reimplementation (interface-free,
  no offset/rounding helpers, two narrower resolver methods
  specialised for new-vs-existing intent), but the design is theirs.
- **Action / part registry pattern** — the per-`_type` registry
  (`registerActionUtil` / `getActionUtil`, with the symmetric pair
  for prompt parts) is **patterned after upstream's**
  [`AgentActionUtil.ts`](https://github.com/tldraw/agent-template/blob/main/client/actions/AgentActionUtil.ts)
  and
  [`PromptPartUtil.ts`](https://github.com/tldraw/agent-template/blob/main/client/parts/PromptPartUtil.ts).
  My versions are simpler (a flat `Map<type, util>` rather than
  default + mode-specific registries; interfaces rather than the
  abstract-class hierarchy with `getInfo` / `sanitizeAction` /
  `savesToHistory` methods), but the registry concept is theirs:
  - `packages/agent-core/src/client/action-util.ts`
  - `packages/agent-core/src/client/part-util.ts`
- **Per-`_type` util files (file-per-util layout, naming)** — the
  layout under `packages/agent-core/src/client/actions/` and
  `packages/agent-core/src/client/parts/` (one file per `_type`,
  each registering itself with names like `MessageActionUtil`,
  `CreateActionUtil`, `SelectedShapesPartUtil`,
  `ChatHistoryPartUtil`) **comes from upstream's** [`client/actions/`](https://github.com/tldraw/agent-template/tree/main/client/actions)
  and [`client/parts/`](https://github.com/tldraw/agent-template/tree/main/client/parts)
  directories. The Anipres set is narrower (only the actions / parts
  the presentation model needs); the individual implementations are
  object literals rather than upstream's class hierarchy. Directory
  shape and naming are theirs.
- **`buildPromptFromEditor` perception assembly** — iterate the
  registered part utils and project editor state into prompt parts:
  the design **comes from upstream**'s prompt-part architecture.
  Anipres-specific parts (`pageShapes`, `selectedShapes`,
  `presentationState`) are mine; the assembly pattern is theirs:
  - `packages/agent-core/src/client/build-prompt.ts`
- **`applyActionStream` consumer loop** — the iterate-streaming-
  iterable + gate-on-`complete: true` + dispatch-through-registry
  shape is **patterned after upstream's** action-applying flow:
  - `packages/agent-core/src/client/apply-action-stream.ts`
- **Zod action schemas with `.meta({ description })`** — the
  pattern of letting one schema double as both runtime validator
  and the LLM-facing JSON-Schema vocabulary (with descriptions
  carried by `.meta()`) is **adopted from upstream**. The Anipres
  schemas (slide, attachCueFrame, focused frame actions, etc.) are
  original; the dual-purpose-schema technique is theirs:
  - `packages/agent-core/src/schemas/actions.ts`
- **`useAgent` React hook surface** — the surface area of the
  hook (`send`, `cancel`, `reset`, plus the chat-log + history
  model) is **informed by upstream's** agent API. The
  implementation here is structurally different (a React hook with
  refs, not a class with managers); the inherited bit is the
  shape of the public API:
  - `packages/agent-core/src/react/use-agent.ts`

The Anipres-specific pieces — the `attachCueFrame` action and
presentation-aware schemas (slides, cue frames, tracks, steps); the
BYO-key worker route and SSE plumbing; the per-document chat
persistence; the CLI / MCP surfaces — are original to this repo.
This boundary is documented for readers tracing concepts back, not
to minimise the upstream contribution.

For the design rationale and how these pieces fit together in the
context of Anipres' presentation model, see `docs/design-agent.md`.
