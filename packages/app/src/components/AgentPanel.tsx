import type { ReactNode } from "react";
import styles from "./AgentPanel.module.css";

interface AgentPanelProps {
  ariaLabel: string;
  headerActions?: ReactNode;
  children: ReactNode;
}

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
