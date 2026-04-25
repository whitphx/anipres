import { WifiOff } from "lucide-react";
import { useEffect, useState } from "react";
import styles from "./NetworkStatus.module.css";

/**
 * Shows an "Offline" pill when the browser reports no network connection.
 * Renders nothing when online — the expected state is signaled by absence
 * of the indicator rather than a persistent green dot, to keep the sidebar
 * footer quiet when nothing is wrong.
 *
 * This reflects the browser's `navigator.onLine` state, not sync-room
 * connectivity. The sync-room reconnect banner lives inside
 * OfflineAwareSyncedContainer because it is per-document state.
 */
export function NetworkStatus() {
  const [online, setOnline] = useState(() =>
    typeof navigator !== "undefined" ? navigator.onLine : true,
  );

  useEffect(() => {
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  if (online) return null;

  return (
    <div className={styles.pill} role="status" aria-live="polite">
      <WifiOff size={14} aria-hidden="true" />
      <span>Offline</span>
    </div>
  );
}
