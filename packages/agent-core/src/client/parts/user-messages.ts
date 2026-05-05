import type { UserMessagesPart } from "../../schemas/parts.js";

/**
 * Build a UserMessagesPart from a plain list of strings. Not a registered
 * util because user input isn't derived from the editor — the caller (CLI,
 * web app) supplies it directly.
 */
export function makeUserMessagesPart(messages: string[]): UserMessagesPart {
  return { type: "userMessages", messages };
}
