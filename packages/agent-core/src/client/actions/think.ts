import type { ThinkAction } from "../../schemas/agent-action.js";
import { registerActionUtil } from "../action-util.js";

export const ThinkActionUtil = registerActionUtil<ThinkAction>({
  type: "think",
  apply() {
    // Same as messages — surfaced by the caller, no editor mutation.
  },
});
