// Shared fixtures for the document-flow test suites (imported by tests
// only; not part of the app bundle).

import { expect } from "vitest";
import { REQUIRED_SYNC_ANIMATION_DATA_VERSION } from "anipres-worker/animation-data-version";
import { CLIENT_ID } from "../lib/client-id";

export function mockResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

/**
 * Rebuilds the outgoing request from a captured `fetch` call. The hono
 * client always passes a relative URL string plus an init object;
 * anchoring the URL makes Request construction work under Node.
 */
export function capturedRequest(call: unknown[]): Request {
  const [input, init] = call as [string, RequestInit | undefined];
  return new Request(new URL(String(input), "http://test.local"), init);
}

/**
 * Full request-shape assertion for a snapshot PUT. Beyond the version
 * header the worker's gate requires, this pins the headers hono
 * computes — `Content-Type: application/json` (without it the worker's
 * json validator rejects the body with 400) and the client id (the
 * WorkspaceFeedRoom's self-echo filter). Passing extra headers through
 * the client's `init.headers` silently REPLACES both; only response
 * mocks would never notice.
 */
export function expectSnapshotPutRequest(call: unknown[]) {
  const request = capturedRequest(call);
  expect(request.method).toBe("PUT");
  expect(request.url).toContain("/snapshot");
  expect(request.headers.get("x-anipres-animation-data-version")).toBe(
    String(REQUIRED_SYNC_ANIMATION_DATA_VERSION),
  );
  expect(request.headers.get("content-type")).toBe("application/json");
  expect(request.headers.get("x-anipres-client-id")).toBe(CLIENT_ID);
}
