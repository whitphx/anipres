import { useCallback, useRef, useState } from "react";
import type { Editor } from "tldraw";
import { getActionUtil } from "../client/action-util.js";
import { AgentHelpers } from "../client/agent-helpers.js";
import { buildPromptFromEditor } from "../client/build-prompt.js";
import { streamFromServer } from "../client/stream-from-server.js";
import type { AgentAction } from "../schemas/actions.js";
import type { ChatHistoryTurn } from "../schemas/parts.js";

// Side-effect imports register the built-in action and part utils so the
// hook can find them. Consumers can register more on top.
import "../client/index.js";

export interface ChatTurn {
  /** "user" turns are what the human typed; "agent" turns are message/think
   *  actions surfaced into the chat log. */
  role: "user" | "agent";
  /** Concatenated text. For the agent, this grows as message/think actions
   *  stream in. */
  text: string;
  /** Whether this turn is still streaming (live updating). */
  streaming: boolean;
}

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
 * (`create`, `attachCueFrame`) hit the editor; `message` and `think`
 * actions surface in the chat log; only `message` text feeds back into
 * the conversation history sent to the model on subsequent turns.
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
      setLog((l) => [
        ...l,
        { role: "user", text, streaming: false },
        { role: "agent", text: "", streaming: true },
      ]);

      const controller = new AbortController();
      abortRef.current = controller;
      const helpers = new AgentHelpers(editor);

      // Latest message-action text seen during this turn — what we'll
      // record as the agent's reply in conversation history.
      let agentReplyText = "";

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
            // Live-stream the agent's words into the trailing turn.
            if (action._type === "message" || action._type === "think") {
              setLog((l) => updateTrailingAgentText(l, action));
              if (action._type === "message") agentReplyText = action.text;
            }

            if (!action.complete) continue;

            const util = getActionUtil(action._type);
            if (util) util.apply(action, { editor, helpers });
          }
        } catch (err) {
          if (controller.signal.aborted) return;
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setLog((l) => markTrailingAgentDone(l));
          if (agentReplyText) {
            setHistory([
              ...historyRef.current,
              { role: "agent", text: agentReplyText },
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

function updateTrailingAgentText(
  log: ChatTurn[],
  action: AgentAction & { _type: "message" | "think" },
): ChatTurn[] {
  if (log.length === 0) return log;
  const last = log[log.length - 1];
  if (last.role !== "agent" || !last.streaming) return log;

  // Replace the trailing turn's text with the latest streamed text. We
  // overwrite rather than append because the action stream re-emits the
  // same action incrementally with growing text on each chunk.
  const prefix = action._type === "think" ? "💭 " : "";
  return [...log.slice(0, -1), { ...last, text: `${prefix}${action.text}` }];
}

function markTrailingAgentDone(log: ChatTurn[]): ChatTurn[] {
  if (log.length === 0) return log;
  const last = log[log.length - 1];
  if (last.role !== "agent" || !last.streaming) return log;
  return [...log.slice(0, -1), { ...last, streaming: false }];
}
