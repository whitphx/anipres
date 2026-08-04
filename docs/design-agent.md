# Design: AI Agent for Anipres

> This document captures the design discussion behind the agent feature
> introduced on `feature/agent` (PR [#477](https://github.com/whitphx/anipres/pull/477)).
> Sections describing the as-built shape reflect that branch as of
> the second review pass; the rationale sections capture decisions
> that survived the build, including a few that emerged from
> debugging arcs rather than from up-front design.
>
> For deferred work see [`agent-todo.md`](./agent-todo.md). For
> earlier server-side architecture (the auth + sync layer this
> agent feature reuses) see [`design-server-sync.md`](./design-server-sync.md).

## Status

The agent ships across three surfaces — Node CLI, in-app chat panel,
and an MCP server for coding-agent hosts. Multi-provider plumbing
(Anthropic / OpenAI / Google), BYO-key, full canvas CRUD plus
animation-track attachment. 23 unit tests, end-to-end verified
against a real Slidev snapshot.

The original direction was set by reading [tldraw's `agent-template`](https://github.com/tldraw/agent-template);
several of its load-bearing patterns survived intact (the streaming
JSON-action protocol, the action-util / part-util registry split, the
provider-agnostic `ai`-SDK adapter). Anipres-specific concerns
(slides, frames, presentation steps, the per-shape track model) are
layered on top.

`agent-template` is MIT-licensed (© 2024 tldraw Inc.). The full
upstream notice and a per-file map of which concepts came from
where live in [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md)
at the repo root; the most clearly inspired files also carry a
top-of-file pointer back to it. The intellectual debt is real and
worth flagging — both as a thank-you to the upstream authors whose
design work this feature builds on, and so future readers can trace
the lineage back to the original.

## Table of Contents

1. [Goal](#goal)
2. [Three Surfaces, One Spine](#three-surfaces-one-spine)
3. [Why a Worker on the Web Path](#why-a-worker-on-the-web-path)
4. [Authentication Posture](#authentication-posture)
5. [BYO-Key vs Hosted Billing](#byo-key-vs-hosted-billing)
6. [Streaming Protocol: JSON-Action vs Native Tool-Use](#streaming-protocol-json-action-vs-native-tool-use)
7. [Perception and Action Registries](#perception-and-action-registries)
8. [Where the Prompt Is Built](#where-the-prompt-is-built)
9. [Anipres-Specific Semantics](#anipres-specific-semantics)
10. [Trade-offs Carried Forward](#trade-offs-carried-forward)

---

## Goal

Let the user describe what they want done to an Anipres presentation
in natural language and have the agent enact it on the canvas — add
slides, recolor shapes, build animation steps. Across three surfaces:

- The **in-app chat panel** for users editing in the browser.
- A **Node CLI** for power users who want to script edits over snapshot
  files (`anipres-agent edit deck.json --prompt "…"`).
- An **MCP server** so coding-agent hosts (Claude Code, Cursor, etc.)
  can drive Anipres docs from the user's existing dev workflow.

The agent should be **provider-pluggable** — Anthropic isn't the only
model worth using, and tomorrow's leading model isn't necessarily
today's. Users should be able to pick.

---

## Three Surfaces, One Spine

```
                                ┌───────────────────────┐
                       ┌────────│ packages/agent-core   │────────┐
                       │        │  schemas / streaming  │        │
                       │        │  registries / models  │        │
                       │        └───────────────────────┘        │
                       │ /server (no tldraw)              /react │ /client
                       │                                  + tldraw│
              ┌────────▼─────────┐                ┌──────────────▼──────────┐
              │ packages/worker  │                │ packages/app + ChatPanel│
              │  /api/agent/     │ ◄─SSE stream─► │ useAgent hook           │
              │   stream (SSE)   │                └──────────────────────────┘
              └──────────────────┘                                ▲
                       ▲                                          │
                       │                                          │
              ┌────────┴─────────┐                ┌───────────────┴──────────┐
              │ packages/agent-  │                │ packages/agent-mcp       │
              │  cli (headless)  │                │ (MCP server, headless)   │
              └──────────────────┘                └──────────────────────────┘
                       │                                         │
                       └─── both load tldraw via happy-dom ──────┘
                            (loadHeadlessEditor from anipres)
```

`packages/agent-core` is the shared spine. It exports three sub-paths:

| Sub-path  | Used by             | Pulls in                          |
| --------- | ------------------- | --------------------------------- |
| `/server` | Worker, CLI, MCP    | `ai`-SDK + provider adapters      |
| `/client` | CLI, MCP, ChatPanel | `tldraw` (action utils run there) |
| `/react`  | ChatPanel only      | `react`                           |

The split lets each consumer pull in only what it needs. The worker
stays React-and-tldraw-free; the CLI and MCP never touch React.

---

## Why a Worker on the Web Path

The worker is the most architecturally questionable piece — the CLI
and MCP both go directly from local Node to the model provider
without any server intermediary. So why does the web path need one?

This is the question worth answering up front because the worker is
where most of the "what does this thing actually do" confusion lives.

### What the worker actually does

1. **Provider abstraction.** The browser sends `{prompt, modelName?}`
   plus a single `X-Anipres-API-Key` header. The worker resolves
   `modelName` → provider (Anthropic / OpenAI / Google), routes the
   key into the right env slot, and calls the matching `ai`-SDK
   adapter. The browser doesn't need to know which provider needs
   which SDK or which API URL.

2. **CORS isolation.** Calling LLM provider APIs directly from the
   browser requires explicit opt-in flags (`dangerouslyAllowBrowser`
   in the OpenAI SDK; equivalents in the Anthropic / Google SDKs as
   they've been added) — the SDKs are named that way for a reason:
   the API key is bundled into client-side code, where any browser
   extension or bookmarklet can read it. The provider's CORS posture
   has been loosening over time, so "you literally can't" is no
   longer accurate everywhere; the substantive point is that browser-
   direct is still the wrong default. Calling from the worker means
   the browser only ever talks to its own origin.

3. **API-key-in-flight isolation.** The key flows browser → your
   worker → provider, never browser → provider. One fewer place the
   key gets logged, intercepted, or fingerprinted (browser
   extensions, ad networks, network inspectors). The key still lives
   in the user's localStorage and in the worker's RAM for the
   request's duration; what we avoid is sending it client-side to a
   third-party domain.

4. **Provider-specific request shaping.** `streamActions` sets:
   - Anthropic `cacheControl: ephemeral` cache breakpoint on the
     system prompt (cuts token cost ~60–80% across turns).
   - Anthropic `thinking: disabled` (we use the explicit `think`
     action instead, which is observable).
   - Google `thinkingConfig.thinkingBudget` per model.
   - OpenAI `reasoningEffort: minimal`.
     The browser doesn't need to know any of this; it sends one prompt
     shape regardless of provider.

5. **Streaming protocol bridging.** The `ai`-SDK gives an async
   iterator of text chunks; the worker runs the cursor-based JSON-
   action parser (`parseActionStream`) and emits SSE `data:` frames
   in our own per-action shape. The browser parses one shape, not
   three providers' three shapes.

6. **Abort propagation upstream.** Client closes the SSE → the
   request's `AbortSignal` fires → worker passes that signal to the
   `ai`-SDK call → provider stops billing. Without this, Cancel in
   the chat panel only stops the browser's `fetch` while the worker
   keeps draining the model stream and the user's API key keeps
   getting billed for the rest of the response. The browser-direct
   path can't do this against Anthropic-the-API directly because…
   it can't talk to Anthropic-the-API directly.

7. **Error classification and sanitization.** Stream errors from the
   provider can be classified (auth / rate-limit / billing) before
   reaching the user. The MCP path already does this via
   `explainNoActionFailure`. The web path forwards `err.message`
   raw today and doesn't even wire the SDK's `onError` callback
   into the worker route — silent provider errors land as a clean-
   looking zero-action stream that the chat panel can't distinguish
   from a model refusal. Both gaps are tracked in
   [`agent-todo.md`](./agent-todo.md) § Operational.

8. **CSRF protection.** The worker has `csrf({ origin: PUBLIC_BASE_URL })`
   middleware. Same-origin requests from the app pass; cross-origin
   POSTs from another domain don't. If the agent route were
   anonymous and the browser called Anthropic directly, the CSRF
   protection on the agent path would not exist.

### Why the CLI / MCP don't have this problem

They run in Node. No CORS. No browser extensions. The local process
can call the provider's API directly using the `ai`-SDK in the same
way the worker does. The worker isn't _needed_ — it's how we
preserve provider choice and abort/cache plumbing for a _browser_
client that can't make those calls itself.

### Could you skip the worker?

Yes — `dangerouslyAllowBrowser: true` would let the browser talk to
OpenAI directly. You'd lose Anthropic and Google support
(CORS-blocked), give up CSRF protection on the agent path, give up
upstream-abort, and accept that the API key flows through any
browser extension that touches network. Not worth it given today's
provider mix.

---

## Authentication Posture

### Today

The agent route is `POST /api/agent/stream`, and the worker has
`app.use("/api/*", session middleware)` from the original sync POC.
**The agent route is therefore behind login by inheritance, not by
deliberate design.** Nothing in the agent's code path requires
`userId`.

### Why keep it (for now)

- **Worker time is the host's resource even with BYO key.** Tokens
  are billed to the user's provider; CPU/wall-time on the worker is
  billed to whoever runs the worker. An anonymous endpoint exposes
  the worker to drive-by abuse — anyone could fire prompts at it
  with their own key (or no key, just to burn CPU on validation).
  Auth is the substrate that future per-user rate limits would build
  on.
- **Future hosted-billing path.** If a "use our worker, we'll bill
  you" tier ever gets offered, login is the substrate. BYO key today
  doesn't preclude a hosted tier tomorrow.
- **Coherent UX with the rest of the app.** The chat panel only
  renders when a document is open; documents come from either
  IndexedDB (anonymous) or the synced repo (logged-in). For users
  who haven't logged in, the chat is non-functional anyway because
  the rest of the synced surface is.

### Why it's worth revisiting

- It adds friction. A user who already has their own Anthropic key
  has to also create an account to use the chat.
- It's conceptually inconsistent with BYO-key — paying for the model
  yourself but still needing to "log in to my server" to use it.

### Open future direction: anonymous as a try-it entry point

A separate, deliberate version of "anonymous agent access" is
worth pursuing as a first-time-visitor demo path: let someone hit
the chat without an account to feel what the agent can do, then
gate persistence / advanced features behind login. Concrete shape:

- A separate route (e.g. `/agent/try-stream`) outside the
  `/api/*` auth middleware, OR a special-case in `registerApiAuth`.
- IP-based rate limiting (token bucket, e.g. 5 prompts / hour)
  since there's no per-user identity to limit on.
- The chat panel detects "no session" and uses the anonymous
  endpoint, with a banner ("Sign in to save this conversation,
  build presentations of your own…").
- Localstorage chat persistence for the doc the visitor is playing
  with stays, but per-doc scoping is a single anonymous "scratch"
  doc since they have no account.

Tracked in [`agent-todo.md`](./agent-todo.md) under
"Anonymous agent access". This isn't a contradiction of the "keep
auth" stance above — it's a deliberately scoped second path
optimized for discovery, with the authenticated path remaining the
default for serious use.

---

## BYO-Key vs Hosted Billing

**Decision: BYO key everywhere in v0.**

Each surface (chat panel, CLI, MCP) collects the user's provider API
key:

- Chat panel: localStorage + sent per request as a header.
- CLI: env var (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`).
- MCP: env block of the host's MCP config.

The host (worker, CLI process, MCP host) never persists the key.

### Why

- **Zero billing infrastructure required.** No payment integration,
  no invoicing, no quota enforcement. The user's relationship is
  with the model provider, not with us.
- **Avoids being a finger-pointed middleman.** When a user gets
  charged unexpectedly because they prompted the agent into a long
  multi-action run, the bill comes from Anthropic/OpenAI/Google
  with their own usage breakdown, not from us with our own
  metering layer they have to trust.
- **Easy to upgrade later.** A future "use our key" tier can
  coexist with BYO. The worker route would just check whether the
  caller supplied a key vs falling back to a host-side one, with
  per-tier rate limits.

### Risks

- **API key in localStorage.** XSS in any part of the app can
  exfiltrate the key. The chat panel's hint copy spells out where
  the key gets sent; we do not (and should not) try to "encrypt"
  it in a way that's still readable by the same JavaScript
  context — that's security theatre.
- **Worker time abuse.** Discussed above (see Authentication
  Posture).

---

## Streaming Protocol: JSON-Action vs Native Tool-Use

**Decision: stream a JSON-shaped action array via prefilled
assistant content, parse it incrementally with a hand-rolled
brace-stack closer.** Mirrors tldraw's `agent-template` pattern.

The model is told to emit:

```json
{"actions": [{"_type": "...", ...}, ...]}
```

We prefill the assistant turn with the opening of that object
(`{"actions": [{"_type":`) so it's committed to the JSON shape from
the first token. The Worker buffers chunks, runs `closeAndParseJson`
to parse the partial JSON, and yields each action twice: once with
`complete: false` while the JSON is still streaming, and once with
`complete: true` when the next array element begins (or the stream
ends).

### Why not native tool-use

- **Provider neutrality.** The `ai`-SDK abstracts over each
  provider's tool-use API, but each one has its own quirks (parallel
  vs sequential calls, schema dialects, finish-reason semantics).
  The custom JSON-action protocol works identically across all
  three providers; we lean on the `ai`-SDK only for the text-stream
  primitive, which is uniform.
- **No round-trip per tool call.** Native tool-use traditionally
  requires the host to execute the tool and call back with the
  result. Our actions are fire-and-forget mutations on the editor
  — the model doesn't need to wait for "the slide was created"
  before deciding the next action; it already assumes it succeeds
  and emits the next action in the same stream.
- **Streamable per partial JSON.** With native tool-use, you typically
  get the full tool-call payload in one message, parsed once. Our
  parser yields per-action progress that lets the chat panel render
  inline action feedback ("Updated shape:r1 → orange") as each
  action arrives, instead of one big drop at the end.

### What it costs

- **Schema is paid in tokens every turn for non-Anthropic
  providers** (Anthropic gets cache control). Tracked in
  [`agent-todo.md`](./agent-todo.md).
- **Hand-rolled parser** for incomplete JSON. Small (~70 lines), but
  it's our problem if a model emits something pathological. The
  parser already had one bug found and fixed during this PR (escape
  detection on `\\\"`); future bugs are on us, not on the SDK.

---

## Perception and Action Registries

The agent's vocabulary is built up via two small registries:

```ts
registerActionUtil({ type: "create", apply(action, ctx) {…} });
registerPartUtil({ type: "pageShapes", getPart(ctx) {…} });
```

Each action type is a Zod schema (under `agent-core/src/schemas/actions.ts`)
plus a util that knows how to apply it to a tldraw `Editor`. Each
perception part is a Zod schema (under `schemas/parts.ts`) plus a
util that knows how to read it off the editor.

The streaming pipeline is part-and-action-agnostic: it parses
discriminated-union actions and dispatches to the registered util.
Adding a new shape kind, a new mutation, or a new perception
dimension is a one-file change.

The `system prompt` and the per-action `getInfo` `description` /
`title` strings teach the model what each action does — they're
surfaced into the JSON schema sent to the model via Zod's `.meta()`
metadata. Ergonomically, the schema and the prose live next to each
other.

---

## Where the Prompt Is Built

**Decision: the browser builds the prompt by introspecting its own
editor.** The worker just relays.

`buildPromptFromEditor(editor, userMessage, options?)` walks every
registered part-util, calls each `getPart(ctx)`, and assembles the
discriminated-union of parts into a single `AgentPrompt` object that
the browser POSTs to the worker.

### Why client-side

- The editor's reactive state is closest to the user's actions
  (e.g., the _current_ selection at send-time). Round-tripping just
  to read shapes the worker doesn't have access to anyway is
  pointless.
- The same `buildPromptFromEditor` works in the headless paths
  (CLI, MCP) — they have a tldraw `Editor` instance too (via
  `loadHeadlessEditor`), just running under happy-dom in Node
  instead of in a browser.
- Keeps the worker truly stateless. No editor state, no perception
  logic — just provider routing + streaming.

### What this implies

- The worker treats the prompt as opaque JSON validated against the
  `AgentPrompt` schema. It doesn't reason about shapes or selection.
- The browser pays the cost of computing perception (small —
  sub-ms for typical scenes; the largest snapshot we've tested is
  the user's ~70-shape Git deck and it takes microseconds).
- A schema drift between what the browser sends and what the worker
  expects would manifest as a Zod validation failure in
  `streamActions` — currently shoved into the SSE error frame, with
  the same classifier path the auth/rate-limit errors get.

---

## Anipres-Specific Semantics

Three things the agent has to know that aren't general tldraw:

### Slides auto-attach a `cameraZoom` cue frame

In `Anipres.tsx`, the React component installs a
`registerBeforeCreateHandler` that does two unrelated things in one
hook: (a) adds a `cameraZoom` cue frame to any newly-created slide
shape, and (b) reassigns frame ids when a frame-bearing shape is
duplicated, to preserve the invariant that each frame id is unique.
Only (a) is mirrored on the agent side — the agent never duplicates
shapes, so (b) doesn't apply.

The agent's `CreateActionUtil` mirrors (a) in its slide branch —
same shape, called at apply time — so slides created via the agent
in headless flows (CLI, MCP) get the cue frame too, preserving the
invariant that "creating a slide makes a step in the timeline."

Two divergences were worth flagging because the two implementations
**didn't** actually compute the same value, despite the doc-string
intent. Animation Data Model v2 dissolved them: `globalIndex` is gone
and both sides now append via `orderKeyBetween`, so the rest of this
subsection is the record of a divergence that can no longer occur.

- `Anipres.tsx`'s handler picked `globalIndex: orderedSteps.length`
  (count of currently-rendered steps).
- The agent's `buildAutoCameraCueFrame` and `attachCueFrame` apply
  paths used `getNextGlobalIndexFromCueFrames`, which is
  `Math.max(...indexes) + 1`.

These agreed on a healthy timeline (no gaps), and differed when there
_were_ gaps — e.g. after a delete that wasn't reconciled, the React
side picked the count (skipping the gap), the agent side picked
max+1 (preserving the gap as a hole). Tracked in
[`agent-todo.md`](./agent-todo.md) § Headless presentation
reconciliation, but listed there under deletion. The fix contemplated
at the time was a single canonical `nextGlobalIndex` helper called by
both sides.

### Each frame lives on a single shape

Anipres's animation model attaches a `Frame` (cue or sub) to each
shape's `meta.frame`. To animate a shape from state A to state B,
you create _two_ shapes (different ids, same `trackId`) in
different steps. The agent's `attachCueFrame` action
takes a `prevShapeId` so the agent can chain a new shape onto an
existing track without needing to know about frame IDs at all.

### Track and step placement are auto-assigned

The agent never sets `trackId`, `stepId` or `stepOrderKey` directly.
The `attachCueFrame` apply path:

- Mints a fresh `stepId` and an order key past the last derived step,
  appending the cue frame as a new step.
- If `prevShapeId` is given, reuses _that_ shape's `trackId`. If
  not, mints a new `trackId`.

This keeps the agent's surface narrow ("attach a cue frame to this
shape, optionally chained from another shape") and prevents
invariant violations (two cue frames sharing both a `trackId` and a
step, which the derivation has to split apart).

---

## Trade-offs Carried Forward

These are the conscious choices — not bugs, not gaps, but design
positions worth re-examining if usage outgrows them. See
[`agent-todo.md`](./agent-todo.md) for the full follow-up list with
context.

- **Narrow `create` shape vocabulary** (rectangle + slide). The
  perception layer covers more — ellipse, line, arrow, text — but
  `create` is intentionally minimal until each new kind has a
  real use case behind it.
- **No streaming preview in the editor.** Shapes appear when each
  action completes, not as the JSON arrives. The chat panel's
  inline-action log entries cover the same UX need from a different
  angle.
- **Headless flows skip presentation reconciliation.** Dissolved by
  Animation Data Model v2: steps carry explicit ids and fractional
  order keys, so deleting a frame-bearing shape via CLI/MCP leaves
  no index gap for a side-effect handler to heal.
- **No native tool-use.** Discussed above. The custom JSON-action
  protocol gives provider neutrality and progressive parsing at the
  cost of one more thing in our codebase to maintain.
