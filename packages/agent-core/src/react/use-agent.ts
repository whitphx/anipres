import { useCallback, useRef, useState } from "react";
import type { Editor } from "tldraw";
import { getActionUtil } from "../client/action-util.js";
import { AgentHelpers } from "../client/agent-helpers.js";
import { buildPromptFromEditor } from "../client/build-prompt.js";
import { streamFromServer } from "../client/stream-from-server.js";
import type { AgentAction } from "../schemas/actions.js";
import type { ChatHistoryTurn } from "../schemas/parts.js";
import type { Streaming } from "../types.js";

// Side-effect imports register the built-in action and part utils so the
// hook can find them. Consumers can register more on top.
import "../client/index.js";

export type ChatTurn =
  | {
      /** What the human typed. */
      role: "user";
      text: string;
      streaming: false;
    }
  | {
      /** A `message` or `think` action surfaced into the log.
       *  `streaming: true` while the text is still arriving. */
      role: "agent";
      text: string;
      streaming: boolean;
    }
  | {
      /** A completed canvas-mutating action (`create`, `update`, `delete`,
       *  `attachCueFrame`). One entry per action so multi-action runs feel
       *  responsive — the user sees progress instead of a single stalled
       *  agent bubble. Does not feed back into the model history. */
      role: "action";
      text: string;
      streaming: false;
    };

export interface UseAgentOptions {
  editor: Editor | null;
  endpoint?: string;
}

export interface AgentChatState {
  /** The visible chat log — what the UI renders. */
  log: ChatTurn[];
  /** The clean history sent to the model on the next turn — only
   *  user / agent message text, no think text. */
  history: ChatHistoryTurn[];
}

export interface UseAgentReturn {
  send: (input: { text: string; modelName: string; apiKey: string }) => void;
  cancel: () => void;
  reset: () => void;
  /** Replace both the visible log and the model-facing history at once.
   *  Aborts any in-flight request first. Used by callers that persist
   *  conversations across mounts (e.g. per-document chat history). */
  restore: (state: AgentChatState) => void;
  isRunning: boolean;
  log: ChatTurn[];
  /** Snapshot of the model-facing history. Reactive; changes whenever a
   *  user or agent turn commits. Surfaced for callers that want to
   *  persist it. */
  history: ChatHistoryTurn[];
  error: string | null;
}

/**
 * React hook that owns one agent conversation against a tldraw editor.
 *
 * `send` POSTs the user's message + the editor's perception to the worker,
 * streams actions back, and applies them: visible-state changes
 * (`create`, `update`, `delete`, `attachCueFrame`) hit the editor and emit
 * an `action` log entry; `message` and `think` actions surface as `agent`
 * log entries; only `message` text feeds back into the conversation
 * history sent to the model on subsequent turns.
 */
export function useAgent(opts: UseAgentOptions): UseAgentReturn {
  const { editor, endpoint = "/api/agent/stream" } = opts;
  const [log, setLog] = useState<ChatTurn[]>([]);
  const [history, setHistoryState] = useState<ChatHistoryTurn[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Mirrors of state read inside the async send loop. Read sync here
  // avoids the stale-closure trap that useState values have inside an
  // async callback created by useCallback.
  const historyRef = useRef<ChatHistoryTurn[]>([]);
  const isRunningRef = useRef(false);

  const setHistory = useCallback((next: ChatHistoryTurn[]) => {
    historyRef.current = next;
    setHistoryState(next);
  }, []);

  const send = useCallback<UseAgentReturn["send"]>(
    ({ text, modelName, apiKey }) => {
      if (!editor) return;
      if (isRunningRef.current) return;

      const priorHistory = historyRef.current;
      // Commit the user turn into the history that will be sent on the
      // *next* request immediately, so a quick double-send sees this turn.
      setHistory([...priorHistory, { role: "user", text }]);

      isRunningRef.current = true;
      setError(null);
      setIsRunning(true);
      setLog((l) => [...l, { role: "user", text, streaming: false }]);

      const controller = new AbortController();
      abortRef.current = controller;
      const helpers = new AgentHelpers(editor);

      // Collect every completed `message` action's text so the model sees
      // the full agent reply on the next turn — not just the last message.
      const messageTexts: string[] = [];

      void (async () => {
        try {
          const prompt = buildPromptFromEditor(editor, text, {
            chatHistory: priorHistory,
          });
          const stream = streamFromServer({
            endpoint,
            prompt,
            modelName,
            apiKey,
            signal: controller.signal,
          });

          for await (const action of stream) {
            if (action._type === "message" || action._type === "think") {
              setLog((l) => writeStreamingAgentTurn(l, action));
              if (action.complete && action._type === "message") {
                messageTexts.push(action.text);
              }
              continue;
            }

            if (!action.complete) continue;

            // Completed canvas-mutating action: log it, then apply.
            const description = describeMutationAction(action);
            if (description) {
              setLog((l) => [
                ...l,
                { role: "action", text: description, streaming: false },
              ]);
            }
            const util = getActionUtil(action._type);
            if (util) util.apply(action, { editor, helpers });
          }
        } catch (err) {
          if (controller.signal.aborted) return;
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setLog(finalizeStreamingAgentTurn);
          if (messageTexts.length > 0) {
            setHistory([
              ...historyRef.current,
              { role: "agent", text: messageTexts.join("\n\n") },
            ]);
          }
          isRunningRef.current = false;
          setIsRunning(false);
          abortRef.current = null;
        }
      })();
    },
    [editor, endpoint, setHistory],
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setHistory([]);
    setLog([]);
    setError(null);
  }, [setHistory]);

  const restore = useCallback<UseAgentReturn["restore"]>(
    (state) => {
      abortRef.current?.abort();
      isRunningRef.current = false;
      setIsRunning(false);
      setError(null);
      setLog(state.log);
      setHistory(state.history);
    },
    [setHistory],
  );

  return { send, cancel, reset, restore, isRunning, log, history, error };
}

/**
 * Append the latest text from a streaming message/think action to the
 * trailing agent turn. If the trailing turn isn't a streaming agent turn
 * (e.g. the previous action was a mutation, or this is the first agent
 * action of the turn), start a new agent entry.
 */
function writeStreamingAgentTurn(
  log: ChatTurn[],
  action: Streaming<AgentAction> & { _type: "message" | "think" },
): ChatTurn[] {
  const text = (action._type === "think" ? "💭 " : "") + action.text;
  const last = log[log.length - 1];
  const streaming = !action.complete;

  if (last && last.role === "agent" && last.streaming) {
    return [...log.slice(0, -1), { role: "agent", text, streaming }];
  }
  return [...log, { role: "agent", text, streaming }];
}

/**
 * On stream end, mark the trailing agent turn as no longer streaming.
 * (Other entry types are already non-streaming.)
 */
function finalizeStreamingAgentTurn(log: ChatTurn[]): ChatTurn[] {
  const last = log[log.length - 1];
  if (!last || last.role !== "agent" || !last.streaming) return log;
  return [...log.slice(0, -1), { ...last, streaming: false }];
}

function describeMutationAction(action: AgentAction): string | null {
  switch (action._type) {
    case "create":
      return `Created ${action.shape._type} (${action.shape.shapeId})`;
    case "update": {
      const fields: string[] = [];
      if (action.color !== undefined) fields.push(`color=${action.color}`);
      if (action.x !== undefined) fields.push(`x=${action.x}`);
      if (action.y !== undefined) fields.push(`y=${action.y}`);
      if (action.w !== undefined) fields.push(`w=${action.w}`);
      if (action.h !== undefined) fields.push(`h=${action.h}`);
      if (action.text !== undefined) fields.push("text");
      const fieldStr = fields.length > 0 ? ` { ${fields.join(", ")} }` : "";
      return `Updated ${action.shapeId}${fieldStr}`;
    }
    case "delete":
      return `Deleted ${action.shapeId}`;
    case "attachCueFrame": {
      const after = action.prevShapeId ? ` (after ${action.prevShapeId})` : "";
      return `Attached cue frame to ${action.shapeId}${after}`;
    }
    default:
      return null;
  }
}
