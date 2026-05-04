import { WifiOff } from "lucide-react";
import { useSyncExternalStore } from "react";
import styles from "./NetworkStatus.module.css";

function subscribeToNetworkStatus(notify: () => void) {
  window.addEventListener("online", notify);
  window.addEventListener("offline", notify);
  return () => {
    window.removeEventListener("online", notify);
    window.removeEventListener("offline", notify);
  };
}

function getNetworkStatusSnapshot() {
  return navigator.onLine;
}

// Server snapshot: assume online when there is no navigator (SSR or
// pre-hydration). The app is currently a Vite SPA so this branch is
// effectively unreachable, but useSyncExternalStore requires it.
function getNetworkStatusServerSnapshot() {
  return true;
}

/**
 * Shows an "Offline" pill when the browser reports no network connection.
 * Renders nothing when online — the expected state is signaled by absence
 * of the indicator rather than a persistent green dot, to keep the sidebar
 * footer quiet when nothing is wrong.
 *
 * Uses useSyncExternalStore to avoid a stale-state race between the
 * initial render and the listener subscription that would otherwise
 * affect the manual useState/useEffect pattern.
 *
 * This reflects the browser's `navigator.onLine` state, not sync-room
 * connectivity. The sync-room reconnect banner lives inside
 * OfflineAwareSyncedContainer because it is per-document state.
 */
export function NetworkStatus() {
  const online = useSyncExternalStore(
    subscribeToNetworkStatus,
    getNetworkStatusSnapshot,
    getNetworkStatusServerSnapshot,
  );

  if (online) return null;

  return (
    <div className={styles.pill} role="status" aria-live="polite">
      <WifiOff size={14} aria-hidden="true" />
      <span>Offline</span>
    </div>
  );
}
