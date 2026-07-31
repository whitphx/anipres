// Shared user-facing copy for a version-gated stale bundle. The worker
// rejects both surfaces from an outdated app — sync connections (close
// code 4099 + CLIENT_TOO_OLD) and snapshot pushes (HTTP 426) — and the
// remedy is identical, so every screen and result path uses one message.
export const CLIENT_TOO_OLD_MESSAGE =
  "This tab is running an outdated version of the app. Reload to continue.";
