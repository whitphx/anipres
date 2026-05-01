import { useEffect, useRef } from "react";

const POLLING_INTERVAL_MS = 30_000;

/**
 * Trigger `onChange` when the workspace's document list might have
 * changed on the server. Three signals feed in:
 *
 * - **SSE** — `GET /api/workspaces/:id/events` streams `data: {...}`
 *   lines whenever a document mutation commits in the workspace.
 *   Provides near-instant cross-client updates while connected.
 * - **Polling** — every 30 s, regardless of SSE state. Catches
 *   anything missed during a stream drop or worker DO restart.
 * - **Focus** — refetches on tab focus. Covers the "switched away
 *   for a while, came back" path without waiting for the next tick.
 *
 * `workspaceId` of `null` (logged out, or workspace not yet
 * resolved) wires up nothing.
 */
export function useWorkspaceFeed(
  workspaceId: string | null,
  onChange: () => void,
) {
  // Latest-callback ref pattern — keeps the long-lived EventSource
  // callback pointing at the current `onChange` without tearing the
  // stream down on every render.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  useEffect(() => {
    if (workspaceId === null) return;

    const url = `/api/workspaces/${workspaceId}/events`;
    const es = new EventSource(url);
    es.onmessage = () => {
      onChangeRef.current();
    };

    const interval = window.setInterval(() => {
      onChangeRef.current();
    }, POLLING_INTERVAL_MS);

    const onFocus = () => {
      onChangeRef.current();
    };
    window.addEventListener("focus", onFocus);

    return () => {
      es.close();
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [workspaceId]);
}
