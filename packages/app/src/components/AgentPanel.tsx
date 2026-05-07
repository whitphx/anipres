import type { ReactNode } from "react";
import styles from "./AgentPanel.module.css";

interface AgentPanelProps {
  /** Accessible label for the `<aside>` landmark. ChatPanel uses
   *  "AI agent chat", AgentLoginPromo uses "AI agent (sign in
   *  required)" — distinct so screen readers announce the right
   *  state at a glance. */
  ariaLabel: string;
  /** Right-aligned content rendered inside the header next to the
   *  "Agent" title. ChatPanel uses this for the model select,
   *  settings, and clear-chat buttons; AgentLoginPromo leaves it
   *  empty. */
  headerActions?: ReactNode;
  children: ReactNode;
}

/**
 * Shared shell for the right-rail agent slot — fixed-width `<aside>`
 * with a header bar containing the "Agent" title and optional
 * right-aligned actions. ChatPanel and AgentLoginPromo both render
 * into this shell so the layout doesn't shift when the user logs
 * in / out, and so the chrome (border, background, header height)
 * stays in one place rather than getting copied across components.
 */
export function AgentPanel({
  ariaLabel,
  headerActions,
  children,
}: AgentPanelProps) {
  return (
    <aside className={styles.panel} aria-label={ariaLabel}>
      <header className={styles.header}>
        <span className={styles.title}>Agent</span>
        {headerActions}
      </header>
      {children}
    </aside>
  );
}
