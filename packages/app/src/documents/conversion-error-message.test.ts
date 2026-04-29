import { describe, expect, it } from "vitest";
import { getConversionErrorMessage } from "./conversion-error-message";

function withName(name: string, message: string): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

describe("getConversionErrorMessage", () => {
  it("maps 413 to a too-large message across each throw site", () => {
    expect(
      getConversionErrorMessage(new Error("Asset upload failed: 413")),
    ).toMatch(/too large/i);
    expect(
      getConversionErrorMessage(new Error("Snapshot push failed: 413")),
    ).toMatch(/too large/i);
    // Document finalize doesn't realistically return 413, but the
    // helper covers the throw-site prefix uniformly so a future
    // path that surfaces a finalize failure renders the same family
    // of friendly messages instead of falling through to the generic.
    expect(
      getConversionErrorMessage(new Error("Document finalize failed: 413")),
    ).toMatch(/too large/i);
  });

  it("maps 401 / 403 to a re-login message", () => {
    expect(
      getConversionErrorMessage(new Error("Asset upload failed: 401")),
    ).toMatch(/log in/i);
    expect(
      getConversionErrorMessage(new Error("Asset upload failed: 403")),
    ).toMatch(/log in/i);
  });

  it("maps other 4xx to a server-rejected message that surfaces the status", () => {
    expect(
      getConversionErrorMessage(new Error("Asset upload failed: 422")),
    ).toMatch(/server rejected/i);
    expect(
      getConversionErrorMessage(new Error("Asset upload failed: 422")),
    ).toMatch(/422/);
  });

  it("maps 5xx to a server-trouble message", () => {
    expect(
      getConversionErrorMessage(new Error("Snapshot push failed: 500")),
    ).toMatch(/server is having trouble/i);
    expect(
      getConversionErrorMessage(new Error("Snapshot push failed: 502")),
    ).toMatch(/server is having trouble/i);
  });

  it("maps TimeoutError and AbortError to a timeout message", () => {
    expect(
      getConversionErrorMessage(withName("TimeoutError", "signal timed out")),
    ).toMatch(/timed out/i);
    expect(
      getConversionErrorMessage(withName("AbortError", "aborted")),
    ).toMatch(/timed out/i);
  });

  it("maps fetch-network failures (TypeError) to a connection message", () => {
    expect(
      getConversionErrorMessage(withName("TypeError", "Failed to fetch")),
    ).toMatch(/couldn't reach the server/i);
    // Match by message text too — older browsers / non-fetch sources.
    expect(
      getConversionErrorMessage(
        new Error("NetworkError when attempting to fetch resource."),
      ),
    ).toMatch(/couldn't reach the server/i);
  });

  it("falls back to a generic message for unrecognized errors", () => {
    expect(getConversionErrorMessage(new Error("something weird"))).toMatch(
      /something went wrong/i,
    );
  });
});
