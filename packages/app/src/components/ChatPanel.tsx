import { useEffect, useRef, useState } from "react";
import {
  AGENT_MODEL_DEFINITIONS,
  DEFAULT_MODEL_NAME,
  getAgentModelDefinition,
  type AgentModelName,
  type AgentModelProvider,
} from "@anipres/agent-core";
import { useAgent, type AgentChatState } from "@anipres/agent-core/react";
import { useDocumentManagerContext } from "../documents/useDocumentManagerContext";
import styles from "./ChatPanel.module.css";

const MODEL_OPTIONS = Object.keys(AGENT_MODEL_DEFINITIONS) as AgentModelName[];

// Distinct providers represented in the registry — drives the settings
// panel's per-provider key inputs. Derived (rather than hard-coded) so
// adding a new provider to the model registry surfaces the input
// without a second edit here.
const ENABLED_PROVIDERS: AgentModelProvider[] = Array.from(
  new Set(Object.values(AGENT_MODEL_DEFINITIONS).map((d) => d.provider)),
);

const PROVIDER_DISPLAY: Record<
  AgentModelProvider,
  { label: string; placeholder: string }
> = {
  anthropic: { label: "Anthropic", placeholder: "sk-ant-..." },
  openai: { label: "OpenAI", placeholder: "sk-..." },
  google: { label: "Google AI", placeholder: "AIza..." },
};

const STORAGE_MODEL_KEY = "anipres.agent.modelName";
// Pre-multi-provider single-key storage. Read once at startup for
// migration into the per-provider slots, then deleted.
const LEGACY_API_KEY_STORAGE = "anipres.agent.apiKey";
const apiKeyStorageKey = (provider: AgentModelProvider) =>
  `anipres.agent.apiKey.${provider}`;
const chatStorageKey = (docId: string) => `anipres.chat.${docId}`;

type ApiKeys = Record<AgentModelProvider, string>;

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
  const [apiKeys, setApiKeys] = useState<ApiKeys>(() => loadApiKeys());
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

  // The provider whose key we'll send with the next request — derived
  // from the currently-selected model rather than typed directly, so
  // switching the model dropdown automatically routes to the right key.
  const activeProvider = getAgentModelDefinition(modelName).provider;
  const activeApiKey = apiKeys[activeProvider] ?? "";

  const disabled = !editor || isRunning;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // Enter-to-submit fires even though the Send button is disabled
    // while the agent is running; without this guard the early-return
    // in `useAgent.send` would still let `setText("")` clear the user's
    // typed-ahead follow-up message.
    if (disabled) return;
    const trimmed = text.trim();
    if (!trimmed || !editor) return;
    if (!activeApiKey) {
      setShowSettings(true);
      return;
    }
    send({ text: trimmed, modelName, apiKey: activeApiKey });
    setText("");
  };

  const handleSaveKey = (provider: AgentModelProvider, next: string) => {
    setApiKeys((prev) => ({ ...prev, [provider]: next }));
    if (next) localStorage.setItem(apiKeyStorageKey(provider), next);
    else localStorage.removeItem(apiKeyStorageKey(provider));
  };

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
          {ENABLED_PROVIDERS.map((provider) => {
            const display = PROVIDER_DISPLAY[provider];
            const inputId = `agent-api-key-${provider}`;
            return (
              <div key={provider} className={styles.settingsRow}>
                <label className={styles.settingsLabel} htmlFor={inputId}>
                  {display.label} API key
                  {provider === activeProvider && (
                    <span className={styles.settingsActive}> (in use)</span>
                  )}
                </label>
                <input
                  id={inputId}
                  type="password"
                  className={styles.settingsInput}
                  placeholder={display.placeholder}
                  value={apiKeys[provider] ?? ""}
                  onChange={(e) => handleSaveKey(provider, e.target.value)}
                  autoComplete="off"
                />
              </div>
            );
          })}
          <p className={styles.settingsHint}>
            Stored in your browser&apos;s localStorage. The anipres worker
            forwards the key matching the selected model&apos;s provider
            (Anthropic, OpenAI, or Google) for each request and does not persist
            it.
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

function loadApiKeys(): ApiKeys {
  const empty: ApiKeys = { anthropic: "", openai: "", google: "" };
  if (typeof window === "undefined") return empty;

  const out: ApiKeys = { ...empty };
  for (const provider of ENABLED_PROVIDERS) {
    out[provider] = localStorage.getItem(apiKeyStorageKey(provider)) ?? "";
  }

  // Drop the pre-multi-provider single-key entry if it's still
  // around. An earlier draft of this PR migrated the value across to
  // the right per-provider slot, but CodeQL flagged the cross-key
  // data flow as "clear-text storage of sensitive information" —
  // which is in fact the design's premise (see the disclosure in
  // the settings panel) but not worth flagging on every static
  // analysis run. The single-key storage was only briefly the
  // shape; affected users re-enter their key once and then load
  // the per-provider entries as normal.
  localStorage.removeItem(LEGACY_API_KEY_STORAGE);
  return out;
}

function loadModel(): AgentModelName {
  if (typeof window === "undefined") return DEFAULT_MODEL_NAME;
  const stored = localStorage.getItem(STORAGE_MODEL_KEY);
  if (stored && stored in AGENT_MODEL_DEFINITIONS) {
    return stored as AgentModelName;
  }
  return DEFAULT_MODEL_NAME;
}
