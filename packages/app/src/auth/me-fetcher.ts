import { apiClient } from "../lib/api-client";

// 401 is "logged out", not an error — mapping to `null` instead of
// throwing keeps SWR's `error` channel reserved for real server
// failures (5xx) so they surface to the user rather than silently
// logging them out. The `as Response` cast is the price of TS
// narrowing `res` to `never` after the typed status union has been
// exhausted; at runtime `res.status` is still the real number.
export async function fetchMe() {
  const res = await apiClient.auth.me.$get();
  if (res.status === 200) return res.json();
  if (res.status === 401) return null;
  throw new Error(`Request failed (${(res as Response).status})`);
}
