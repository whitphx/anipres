import type {
  ChatHistoryPart,
  ChatHistoryTurn,
} from "../../schemas/prompt-part.js";

/**
 * Build a ChatHistoryPart from in-memory turns. Like `userMessages`, this
 * isn't a registered part-util because the data isn't derived from the
 * editor — the caller (the React hook in v0) supplies it directly.
 */
export function makeChatHistoryPart(turns: ChatHistoryTurn[]): ChatHistoryPart {
  return { type: "chatHistory", turns };
}
