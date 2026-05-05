import { useEffect, useRef, useState } from "react";
import {
  AGENT_MODEL_DEFINITIONS,
  DEFAULT_MODEL_NAME,
  type AgentModelName,
} from "@anipres/agent-core";
import { useAgent } from "@anipres/agent-core/react";
import { useDocumentManagerContext } from "../documents/useDocumentManagerContext";
import styles from "./ChatPanel.module.css";

const MODEL_OPTIONS = Object.keys(AGENT_MODEL_DEFINITIONS) as AgentModelName[];

const STORAGE_KEY = "anipres.agent.apiKey";
const STORAGE_MODEL_KEY = "anipres.agent.modelName";

export function ChatPanel() {
  const { editor } = useDocumentManagerContext();
  const { send, cancel, reset, isRunning, log, error } = useAgent({ editor });

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
          <div
            key={i}
            className={`${styles.turn} ${
              turn.role === "user" ? styles.user : styles.agent
            }`}
          >
            <div className={styles.turnText}>
              {turn.text || (turn.streaming ? "…" : "")}
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
