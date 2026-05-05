import { useCallback, useRef, useState } from "react";
import type { Editor } from "tldraw";
import { getActionUtil } from "../client/action-util.js";
import { AgentHelpers } from "../client/agent-helpers.js";
import { buildPromptFromEditor } from "../client/build-prompt.js";
import { streamFromServer } from "../client/stream-from-server.js";
import type { AgentAction } from "../schemas/actions.js";

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

export interface UseAgentReturn {
  send: (input: { text: string; modelName: string; apiKey: string }) => void;
  cancel: () => void;
  reset: () => void;
  isRunning: boolean;
  log: ChatTurn[];
  error: string | null;
}

/**
 * React hook that owns one agent conversation against a tldraw editor.
 *
 * `send` POSTs the user's message + the editor's perception to the worker,
 * streams actions back, and applies them: visible-state changes
 * (`create`, `attachCueFrame`) hit the editor, while `message` and `think`
 * actions accumulate in the in-memory chat log so the UI can render them.
 */
export function useAgent(opts: UseAgentOptions): UseAgentReturn {
  const { editor, endpoint = "/api/agent/stream" } = opts;
  const [log, setLog] = useState<ChatTurn[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const send = useCallback<UseAgentReturn["send"]>(
    ({ text, modelName, apiKey }) => {
      if (!editor) return;
      if (isRunning) return;

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

      void (async () => {
        try {
          const prompt = buildPromptFromEditor(editor, text);
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
          setIsRunning(false);
          abortRef.current = null;
        }
      })();
    },
    [editor, endpoint, isRunning],
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setLog([]);
    setError(null);
  }, []);

  return { send, cancel, reset, isRunning, log, error };
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
