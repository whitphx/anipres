/**
 * A streamed value: identical to T but with a `complete` flag.
 *
 * The agent yields each action twice: once with `complete: false` while the
 * model is still streaming the JSON for it, then once with `complete: true`
 * when the action is fully received. The client is expected to apply the
 * incomplete version optimistically (and revert it if needed) so the UI
 * updates as the action streams in.
 *
 * The name and concept come from tldraw/agent-template (MIT, © 2024
 * tldraw Inc.)'s
 * [`shared/types/Streaming.ts`](https://github.com/tldraw/agent-template/blob/main/shared/types/Streaming.ts).
 * Their version is a discriminated union (`Partial<T> & { complete:
 * false } | T & { complete: true }`); ours is a flat shape with a
 * boolean discriminator. The protocol is theirs; the type definition
 * here is the simplified rendering. See THIRD_PARTY_NOTICES.md at the
 * repo root.
 */
export type Streaming<T> = T & {
  complete: boolean;
  time?: number;
};

/**
 * Provider credentials. Only the providers actually used at call time are
 * required.
 */
export interface AgentEnv {
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  GOOGLE_API_KEY?: string;
}
