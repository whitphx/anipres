import { useEffect, useRef, useState } from "react";
import {
  AGENT_MODEL_DEFINITIONS,
  DEFAULT_MODEL_NAME,
  type AgentModelName,
} from "@anipres/agent-core";
import { useAgent, type AgentChatState } from "@anipres/agent-core/react";
import { useDocumentManagerContext } from "../documents/useDocumentManagerContext";
import styles from "./ChatPanel.module.css";

const MODEL_OPTIONS = Object.keys(AGENT_MODEL_DEFINITIONS) as AgentModelName[];

const STORAGE_KEY = "anipres.agent.apiKey";
const STORAGE_MODEL_KEY = "anipres.agent.modelName";
const chatStorageKey = (docId: string) => `anipres.chat.${docId}`;

export function ChatPanel() {
  const { editor, activeDocumentId } = useDocumentManagerContext();
  const { send, cancel, reset, restore, isRunning, log, history, error } =
    useAgent({ editor });

  // Restore-vs-persist coordination: when the active document changes we
  // load that doc's history into the hook (writing to log/history). The
  // persist effect below would then immediately re-write the loaded
  // content to localStorage — harmless but wasteful, and risks a race
  // where an in-flight log mutation from the *previous* doc gets
  // persisted under the *new* doc's key. The flag tells the persist
  // effect to skip exactly one cycle right after a restore.
  const skipNextPersistRef = useRef(false);

  // On document switch, load that doc's chat from localStorage and feed
  // it into the hook. No active doc → keep the chat empty (anything the
  // user typed without a doc was already useless).
  useEffect(() => {
    skipNextPersistRef.current = true;
    if (!activeDocumentId) {
      restore({ log: [], history: [] });
      return;
    }
    const stored = localStorage.getItem(chatStorageKey(activeDocumentId));
    if (!stored) {
      restore({ log: [], history: [] });
      return;
    }
    try {
      const parsed = JSON.parse(stored) as Partial<AgentChatState>;
      restore({
        log: Array.isArray(parsed.log) ? parsed.log : [],
        history: Array.isArray(parsed.history) ? parsed.history : [],
      });
    } catch {
      restore({ log: [], history: [] });
    }
  }, [activeDocumentId, restore]);

  // Persist on log/history change. Skip during in-flight streaming so
  // we only commit completed turns; skip immediately after restore so
  // we don't write back what we just read.
  useEffect(() => {
    if (skipNextPersistRef.current) {
      skipNextPersistRef.current = false;
      return;
    }
    if (!activeDocumentId) return;
    const lastTurn = log[log.length - 1];
    if (lastTurn?.streaming) return;
    if (log.length === 0 && history.length === 0) {
      localStorage.removeItem(chatStorageKey(activeDocumentId));
      return;
    }
    localStorage.setItem(
      chatStorageKey(activeDocumentId),
      JSON.stringify({ log, history }),
    );
  }, [activeDocumentId, log, history]);

  const [text, setText] = useState("");
  const [apiKey, setApiKey] = useState<string>(() => loadKey());
  const [modelName, setModelName] = useState<AgentModelName>(() => loadModel());
  const [showSettings, setShowSettings] = useState(false);

  const logScrollerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = logScrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  useEffect(() => {
    localStorage.setItem(STORAGE_MODEL_KEY, modelName);
  }, [modelName]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || !editor) return;
    if (!apiKey) {
      setShowSettings(true);
      return;
    }
    send({ text: trimmed, modelName, apiKey });
    setText("");
  };

  const handleSaveKey = (next: string) => {
    setApiKey(next);
    if (next) localStorage.setItem(STORAGE_KEY, next);
    else localStorage.removeItem(STORAGE_KEY);
  };

  const disabled = !editor || isRunning;

  return (
    <aside className={styles.panel} aria-label="AI agent chat">
      <header className={styles.header}>
        <span className={styles.title}>Agent</span>
        <div className={styles.headerActions}>
          <select
            aria-label="Model"
            className={styles.modelSelect}
            value={modelName}
            onChange={(e) => setModelName(e.target.value as AgentModelName)}
            disabled={isRunning}
          >
            {MODEL_OPTIONS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <button
            type="button"
            aria-label="Settings"
            className={styles.iconBtn}
            onClick={() => setShowSettings((v) => !v)}
          >
            ⚙
          </button>
          <button
            type="button"
            aria-label="Clear chat"
            className={styles.iconBtn}
            onClick={reset}
            disabled={isRunning || log.length === 0}
          >
            ↺
          </button>
        </div>
      </header>

      {showSettings && (
        <div className={styles.settings}>
          <label className={styles.settingsLabel} htmlFor="agent-api-key">
            API key for the selected model&apos;s provider
          </label>
          <input
            id="agent-api-key"
            type="password"
            className={styles.settingsInput}
            placeholder="sk-..."
            value={apiKey}
            onChange={(e) => handleSaveKey(e.target.value)}
            autoComplete="off"
          />
          <p className={styles.settingsHint}>
            Stored in your browser&apos;s localStorage. Sent only to your own
            anipres worker, never to a third party.
          </p>
        </div>
      )}

      <div className={styles.log} ref={logScrollerRef}>
        {log.length === 0 && (
          <p className={styles.empty}>
            {editor
              ? "Ask the agent to add slides, animations, or shapes."
              : "Open a document to start chatting."}
          </p>
        )}
        {log.map((turn, i) => (
          <div key={i} className={`${styles.turn} ${turnClassName(turn.role)}`}>
            <div className={styles.turnText}>
              {turn.text ||
                (turn.role === "agent" && turn.streaming ? "…" : "")}
            </div>
          </div>
        ))}
        {error && (
          <div className={`${styles.turn} ${styles.errorTurn}`} role="alert">
            <div className={styles.turnText}>Error: {error}</div>
          </div>
        )}
      </div>

      <form className={styles.composer} onSubmit={handleSubmit}>
        <textarea
          className={styles.input}
          placeholder={
            editor ? "What should the agent do?" : "No document open"
          }
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSubmit(e);
            }
          }}
          rows={3}
          disabled={!editor}
        />
        <div className={styles.composerActions}>
          {isRunning ? (
            <button type="button" className={styles.cancelBtn} onClick={cancel}>
              Cancel
            </button>
          ) : (
            <button
              type="submit"
              className={styles.sendBtn}
              disabled={disabled || !text.trim()}
            >
              Send
            </button>
          )}
        </div>
      </form>
    </aside>
  );
}

function turnClassName(role: "user" | "agent" | "action"): string {
  switch (role) {
    case "user":
      return styles.user;
    case "agent":
      return styles.agent;
    case "action":
      return styles.action;
  }
}

function loadKey(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(STORAGE_KEY) ?? "";
}

function loadModel(): AgentModelName {
  if (typeof window === "undefined") return DEFAULT_MODEL_NAME;
  const stored = localStorage.getItem(STORAGE_MODEL_KEY);
  if (stored && stored in AGENT_MODEL_DEFINITIONS) {
    return stored as AgentModelName;
  }
  return DEFAULT_MODEL_NAME;
}
