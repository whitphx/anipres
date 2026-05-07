// `applyActionStream`'s consume-and-dispatch loop is patterned after
// tldraw/agent-template (MIT, © 2024 tldraw Inc.) — iterate the
// streaming iterable, gate on `complete: true`, dispatch through the
// per-`_type` action-util registry. See THIRD_PARTY_NOTICES.md at the
// repo root.
import type { Editor } from "tldraw";
import type { AgentAction } from "../schemas/agent-action.js";
import type { Streaming } from "../types/streaming.js";
import { AgentHelpers } from "./agent-helpers.js";
import { getActionUtil } from "./action-util.js";

export interface ApplyActionStreamOptions {
  editor: Editor;
  actions: AsyncIterable<Streaming<AgentAction>>;
  /** Called for each complete action. Useful for surfacing
   *  message/think actions to the terminal in the CLI. */
  onComplete?: (action: AgentAction) => void;
}

/**
 * Iterate a stream of agent actions and apply each completed one to the
 * editor. Incomplete (still-streaming) actions are intentionally dropped in
 * v0; once we add a UI client, we'll add revert-and-reapply for those.
 */
export async function applyActionStream(
  opts: ApplyActionStreamOptions,
): Promise<void> {
  const { editor, actions, onComplete } = opts;
  const helpers = new AgentHelpers(editor);

  for await (const action of actions) {
    if (!action.complete) continue;

    const util = getActionUtil(action._type);
    if (!util) {
      // Throwing — not warning — because a missing util means the
      // registry was never bootstrapped (the side-effect imports in
      // `client/index.ts` didn't run) and the alternative is silently
      // dropping every action and reporting success. Callers that
      // import this module directly need to import the built-ins too.
      throw new Error(
        `No action util registered for type "${action._type}". Did you forget to import "@anipres/agent-core/client" before consuming the stream?`,
      );
    }

    util.apply(action, { editor, helpers });
    onComplete?.(action);
  }
}
