# Third-party notices

Anipres is MIT-licensed (see `LICENSE`). Some parts of the agent
feature were influenced — in pattern, naming, and structure — by the
following third-party project. The originals are reimplemented from
scratch in this repo rather than copy-pasted, but the design lineage
is significant enough that the upstream copyright notice is preserved
here as required by the MIT license.

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

### What was adapted

The agent feature mirrors several architectural patterns from tldraw's
`agent-template`. Each line below points at the structurally
analogous concept in this repo:

- **JSON-action streaming protocol** — assistant prefill of the
  opening `{"actions":[{"_type":` plus a cursor-based partial-JSON
  parser that yields each action twice (`complete: false` then
  `complete: true`):
  - `packages/agent-core/src/server/stream-actions.ts`
  - `packages/agent-core/src/server/close-and-parse-json.ts`
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

Anipres-specific pieces (the `attachCueFrame` action, the
`presentationState` / `slide` projections, the BYO-key worker route,
the per-document chat persistence, the CLI / MCP surfaces, the
parser's escape-counting fix, the multi-action-per-chunk cursor fix,
and the rest of the schema vocabulary) are original to this repo.

For the design rationale and how these pieces fit together in the
context of Anipres' presentation model, see `docs/design-agent.md`.
