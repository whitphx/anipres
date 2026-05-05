import type { Editor } from "tldraw";
import type { AgentAction } from "../schemas/actions.js";
import type { Streaming } from "../types.js";
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
      console.warn(`No action util registered for type: ${action._type}`);
      continue;
    }

    util.apply(action, { editor, helpers });
    onComplete?.(action);
  }
}
