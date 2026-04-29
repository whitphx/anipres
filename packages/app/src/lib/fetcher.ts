/**
 * Default SWR fetcher for JSON endpoints. Throws on non-ok responses
 * so SWR's `error` channel surfaces HTTP failures (including the
 * status code in the message). Endpoints with non-error non-2xx
 * semantics — `/auth/me` returning 401 for "logged out" — supply
 * their own fetcher locally.
 */
export async function jsonFetcher<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}
