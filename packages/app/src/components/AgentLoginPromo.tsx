import { Github, LogIn, Sparkles } from "lucide-react";
import { useAuth } from "../auth/useAuth";
import { AgentPanel } from "./AgentPanel";
import styles from "./AgentLoginPromo.module.css";

/**
 * What logged-out users see in the chat-panel slot. Reuses the
 * shared `AgentPanel` shell so the layout and chrome stay identical
 * to the signed-in `ChatPanel`; only the body differs. Keeps the
 * agent feature discoverable instead of being invisible until the
 * user happens to log in for unrelated reasons. The CTA is sign-in —
 * without an account the agent route 401s, so there's no useful
 * intermediate state.
 */
export function AgentLoginPromo() {
  const { loginWithGitHub, loginWithGoogle } = useAuth();

  return (
    <AgentPanel ariaLabel="AI agent (sign in required)">
      <div className={styles.body}>
        <Sparkles className={styles.icon} aria-hidden size={28} />
        <h2 className={styles.heading}>Edit with AI</h2>
        <p className={styles.lede}>
          Ask an AI agent to add slides, animate shapes, or restructure your
          presentation in plain English.
        </p>
        <p className={styles.detail}>
          Sign in to unlock. Bring your own API key — Anthropic, OpenAI, or
          Google — and your conversations stay tied to the document you&apos;re
          editing.
        </p>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.button}
            onClick={loginWithGitHub}
          >
            <Github size={14} /> Sign in with GitHub
          </button>
          <button
            type="button"
            className={styles.button}
            onClick={loginWithGoogle}
          >
            <LogIn size={14} /> Sign in with Google
          </button>
        </div>
      </div>
    </AgentPanel>
  );
}
