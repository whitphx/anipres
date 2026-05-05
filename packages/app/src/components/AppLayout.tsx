import type { ReactNode } from "react";
import styles from "./AppLayout.module.css";

interface AppLayoutProps {
  sidebar: ReactNode;
  children: ReactNode;
  chatPanel?: ReactNode;
}

export function AppLayout({ sidebar, children, chatPanel }: AppLayoutProps) {
  return (
    <div className={styles.layout}>
      {sidebar}
      <div className={styles.main}>{children}</div>
      {chatPanel}
    </div>
  );
}
