import type { MessageAction } from "../../schemas/agent-action.js";
import { registerActionUtil } from "../action-util.js";

export const MessageActionUtil = registerActionUtil<MessageAction>({
  type: "message",
  apply() {
    // Messages are surfaced by the caller iterating the action stream;
    // there's nothing to apply to the editor.
  },
});
