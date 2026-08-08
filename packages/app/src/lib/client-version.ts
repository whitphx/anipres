// Shared user-facing copy for the version gate's two directions. The
// worker rejects both surfaces the same way — sync connections (close
// code 4099) and snapshot pushes (HTTP 426) — so every screen and
// result path uses these messages.

/** The bundle predates the worker: a reload picks up a newer one. */
export const CLIENT_TOO_OLD_MESSAGE =
  "This tab is running an outdated version of the app. Reload to continue.";

/**
 * The worker predates the bundle (a staggered deploy, a rollback). A
 * reload serves the same bundle the server just rejected, so the only
 * remedy is waiting — local edits keep saving meanwhile.
 */
export const SERVER_TOO_OLD_MESSAGE =
  "This document's server is running an older version. Your changes are saved locally; syncing resumes once it updates.";
