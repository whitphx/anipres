import { Github, LogIn, Sparkles } from "lucide-react";
import { useAuth } from "../auth/useAuth";
import styles from "./ChatPanel.module.css";
import promoStyles from "./AgentLoginPromo.module.css";

/**
 * What logged-out users see in the chat-panel slot. Same `<aside>` shell
 * as `ChatPanel` so the layout doesn't shift when login flips, and it
 * keeps the agent feature discoverable instead of being invisible until
 * the user happens to log in for unrelated reasons. The CTA is
 * sign-in — without an account the agent route 401s, so there's no
 * useful intermediate state.
 */
export function AgentLoginPromo() {
  const { loginWithGitHub, loginWithGoogle } = useAuth();

  return (
    <aside className={styles.panel} aria-label="AI agent (sign in required)">
      <header className={styles.header}>
        <span className={styles.title}>Agent</span>
      </header>

      <div className={promoStyles.body}>
        <Sparkles className={promoStyles.icon} aria-hidden size={28} />
        <h2 className={promoStyles.heading}>Edit with AI</h2>
        <p className={promoStyles.lede}>
          Ask an AI agent to add slides, animate shapes, or restructure your
          presentation in plain English.
        </p>
        <p className={promoStyles.detail}>
          Sign in to unlock. Bring your own API key — Anthropic, OpenAI, or
          Google — and your conversations stay tied to the document you&apos;re
          editing.
        </p>
        <div className={promoStyles.actions}>
          <button
            type="button"
            className={promoStyles.button}
            onClick={loginWithGitHub}
          >
            <Github size={14} /> Sign in with GitHub
          </button>
          <button
            type="button"
            className={promoStyles.button}
            onClick={loginWithGoogle}
          >
            <LogIn size={14} /> Sign in with Google
          </button>
        </div>
      </div>
    </aside>
  );
}
