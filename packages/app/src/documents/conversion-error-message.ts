/**
 * Map a raw failure from the synced-doc upload paths into a
 * user-facing sentence. Anything not recognized falls through to a
 * generic "try again" message — better than exposing internal HTTP
 * / Error vocab to the user.
 */
export function getConversionErrorMessage(error: Error): string {
  // `AbortSignal.timeout` produces a `TimeoutError`; user-cancellation
  // produces `AbortError`. Both manifest as the migration timing out
  // from the user's perspective.
  if (error.name === "TimeoutError" || error.name === "AbortError") {
    return "Upload timed out — check your connection and try again.";
  }

  const httpMatch = error.message.match(
    /^(?:Asset upload|Snapshot push|Document finalize) failed: (\d+)/,
  );
  if (httpMatch) {
    const status = Number(httpMatch[1]);
    if (status === 413) return "This file is too large.";
    if (status === 401 || status === 403) {
      return "Your session has expired. Please log in and try again.";
    }
    if (status >= 400 && status < 500) {
      return `The server rejected the upload (${status}). Try a different file or a smaller one.`;
    }
    if (status >= 500) {
      return "The server is having trouble. Please try again in a moment.";
    }
  }

  // `fetch` rejects with a `TypeError` on network failures — DNS,
  // offline, CORS, certificate, etc. The message text varies by
  // browser ("Failed to fetch", "NetworkError when attempting to
  // fetch resource.", "Load failed"); match by Error name to stay
  // browser-agnostic.
  if (
    error.name === "TypeError" ||
    /failed to fetch|networkerror|load failed/i.test(error.message)
  ) {
    return "Couldn't reach the server. Check your connection and try again.";
  }

  return "Something went wrong. Please try again.";
}
