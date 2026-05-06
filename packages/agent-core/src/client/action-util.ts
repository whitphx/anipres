// The per-`_type` action-util registry pattern (registerActionUtil →
// getActionUtil dispatched in the streaming consumer) is adapted from
// tldraw/agent-template (MIT, © 2024 tldraw Inc.). See
// THIRD_PARTY_NOTICES.md at the repo root.
import type { Editor } from "tldraw";
import type { AgentAction } from "../schemas/actions.js";
import type { Streaming } from "../types.js";
import { AgentHelpers } from "./agent-helpers.js";

export interface ApplyContext {
  editor: Editor;
  helpers: AgentHelpers;
}

export interface AgentActionUtil<T extends AgentAction = AgentAction> {
  type: T["_type"];
  apply(action: Streaming<T>, ctx: ApplyContext): void;
}

const REGISTRY = new Map<AgentAction["_type"], AgentActionUtil>();

export function registerActionUtil<T extends AgentAction>(
  util: AgentActionUtil<T>,
): AgentActionUtil<T> {
  if (REGISTRY.has(util.type)) {
    throw new Error(`Action util already registered for type: ${util.type}`);
  }
  REGISTRY.set(util.type, util as AgentActionUtil);
  return util;
}

export function getActionUtil(
  type: AgentAction["_type"],
): AgentActionUtil | undefined {
  return REGISTRY.get(type);
}

export function getRegisteredActionTypes(): AgentAction["_type"][] {
  return Array.from(REGISTRY.keys());
}
