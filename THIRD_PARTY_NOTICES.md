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

### What's inspired by it

Each line below points at a concept in this repo whose design comes
directly from `agent-template`. The implementations here are
independent reimplementations rather than verbatim copies, but the
shape of each piece — the patterns, the names, the structural
choices — is owed to the upstream:

- **JSON-action streaming protocol** — assistant prefill of the
  opening `{"actions":[{"_type":` plus a cursor-based partial-JSON
  parser that yields each action twice (`complete: false` then
  `complete: true`):
  - `packages/agent-core/src/server/stream-actions.ts`
  - `packages/agent-core/src/server/close-and-parse-json.ts`
- **System-prompt scaffolding** — split into intro + rules with
  `###` sub-sections, the JSON-actions self-description, the "always
  emit at least one action" rule, and the user-selection
  disambiguation idiom ("when the user says 'this' / 'these',
  prefer the selection"). Text was rewritten end-to-end for the
  Anipres vocabulary (slides, cue frames, tracks, steps, worked
  example), but the structure and several idioms came from upstream's
  [`intro-section.ts`](https://github.com/tldraw/agent-template/blob/main/worker/prompt/sections/intro-section.ts)
  and
  [`rules-section.ts`](https://github.com/tldraw/agent-template/blob/main/worker/prompt/sections/rules-section.ts):
  - `packages/agent-core/src/server/build-system-prompt.ts`
- **Action / part registry pattern** — pluggable per-`_type` utils
  registered via `registerActionUtil` / `registerPartUtil`:
  - `packages/agent-core/src/client/action-util.ts`
  - `packages/agent-core/src/client/part-util.ts`
- **AgentHelpers shape-id resolution** — collision-aware id minting
  - lookup so model-supplied placeholder ids and live tldraw ids
    coexist:
  * `packages/agent-core/src/client/agent-helpers.ts`
- **`buildPromptFromEditor` perception assembly** — gather
  `pageShapes` / `selectedShapes` / `presentationState` parts from
  an `Editor` instance:
  - `packages/agent-core/src/client/build-prompt.ts`
- **`applyActionStream` consumer loop** — iterate the streaming
  iterable, gate on `complete: true`, dispatch via the action util
  registry:
  - `packages/agent-core/src/client/apply-action-stream.ts`
- **Zod action schemas with `.meta({ description })`** — the
  schemas double as the LLM's vocabulary via JSON-Schema export:
  - `packages/agent-core/src/schemas/actions.ts`
- **`useAgent` React hook shape** — `send` / `cancel` / `reset` /
  `restore` plus the streaming chat-log model:
  - `packages/agent-core/src/react/use-agent.ts`

For completeness, the Anipres-specific pieces — the
`attachCueFrame` action and presentation-aware schemas (slides, cue
frames, tracks, steps); the BYO-key worker route and SSE plumbing;
the per-document chat persistence; the CLI / MCP surfaces — are
original to this repo. They're noted not to minimise the upstream
debt but to make the boundary legible to readers tracing concepts.

For the design rationale and how these pieces fit together in the
context of Anipres' presentation model, see `docs/design-agent.md`.
