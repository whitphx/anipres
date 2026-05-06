// The per-`_type` action / part util pattern below — file-per-util,
// each file calling `registerActionUtil` / `registerPartUtil` for one
// `_type`, with names like `MessageActionUtil`, `CreateActionUtil`,
// `SelectedShapesPartUtil`, `ChatHistoryPartUtil` — comes from tldraw/
// agent-template (MIT, © 2024 tldraw Inc.)'s `client/actions/` and
// `client/parts/` directories. The Anipres set is smaller (only the
// actions / parts the presentation model actually needs), and the
// individual util implementations are simpler (object literals with
// `apply` / `getPart` rather than upstream's class hierarchy with
// `getInfo` / `sanitizeAction` / `savesToHistory` machinery), but the
// directory shape and naming are theirs. See THIRD_PARTY_NOTICES.md
// at the repo root.

// Side-effect imports register action and part utils into the global
// registries. Anyone importing this barrel ends up with all built-in utils
// available; downstream code can register more on top.
import "./actions/message.js";
import "./actions/think.js";
import "./actions/create-shape.js";
import "./actions/update-shape.js";
import "./actions/delete-shape.js";
import "./actions/attach-cue-frame.js";
import "./parts/page-shapes.js";
import "./parts/presentation-state.js";
import "./parts/selected-shapes.js";

export { AgentHelpers } from "./agent-helpers.js";
export {
  registerActionUtil,
  getActionUtil,
  getRegisteredActionTypes,
  type AgentActionUtil,
  type ApplyContext,
} from "./action-util.js";
export {
  registerPartUtil,
  getPartUtil,
  getRegisteredPartTypes,
  type PromptPartUtil,
  type PartContext,
} from "./part-util.js";
export {
  applyActionStream,
  type ApplyActionStreamOptions,
} from "./apply-action-stream.js";
export { makeUserMessagesPart } from "./parts/user-messages.js";
export { makeDefaultModePart } from "./parts/mode.js";
export { makeChatHistoryPart } from "./parts/chat-history.js";
export {
  focusedShapeToTldrawShape,
  tldrawShapeToFocusedShape,
} from "./convert-shape.js";
export { buildPromptFromEditor } from "./build-prompt.js";
export {
  streamFromServer,
  type StreamFromServerOptions,
} from "./stream-from-server.js";
