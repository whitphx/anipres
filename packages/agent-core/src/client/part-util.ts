import type { Editor } from "tldraw";
import type { PromptPart } from "../schemas/parts.js";

export interface PartContext {
  editor: Editor;
}

export interface PromptPartUtil<T extends PromptPart = PromptPart> {
  type: T["type"];
  getPart(ctx: PartContext): T | null;
}

const REGISTRY = new Map<PromptPart["type"], PromptPartUtil>();

export function registerPartUtil<T extends PromptPart>(
  util: PromptPartUtil<T>,
): PromptPartUtil<T> {
  if (REGISTRY.has(util.type)) {
    throw new Error(`Part util already registered for type: ${util.type}`);
  }
  REGISTRY.set(util.type, util as PromptPartUtil);
  return util;
}

export function getPartUtil(
  type: PromptPart["type"],
): PromptPartUtil | undefined {
  return REGISTRY.get(type);
}

export function getRegisteredPartTypes(): PromptPart["type"][] {
  return Array.from(REGISTRY.keys());
}
