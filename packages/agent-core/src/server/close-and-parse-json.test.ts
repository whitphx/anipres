import { describe, expect, it } from "vitest";
import { closeAndParseJson } from "./close-and-parse-json.js";

describe("closeAndParseJson", () => {
  it("parses well-formed JSON unchanged", () => {
    expect(closeAndParseJson('{"a":1,"b":[2,3]}')).toEqual({
      a: 1,
      b: [2, 3],
    });
  });

  it("closes a missing closing brace", () => {
    expect(closeAndParseJson('{"a":1')).toEqual({ a: 1 });
  });

  it("closes a missing closing bracket inside an object", () => {
    expect(closeAndParseJson('{"actions":[1,2')).toEqual({
      actions: [1, 2],
    });
  });

  it("closes a partial string and ignores trailing comma", () => {
    // Trailing comma inside an array makes the closed result invalid JSON;
    // we expect null in that case.
    expect(
      closeAndParseJson('{"actions":[{"_type":"message","text":"hi'),
    ).toEqual({ actions: [{ _type: "message", text: "hi" }] });
  });

  it("returns null when the result still doesn't parse", () => {
    // A bare colon with nothing on either side cannot be closed into valid JSON.
    expect(closeAndParseJson(":")).toBeNull();
  });

  it("ignores escaped quotes inside a string", () => {
    expect(closeAndParseJson('{"text":"he said \\"hi')).toEqual({
      text: 'he said "hi',
    });
  });

  it("handles the prefilled action prefix the streamer uses", () => {
    expect(closeAndParseJson('{"actions": [{"_type":')).toBeNull();
    expect(
      closeAndParseJson('{"actions": [{"_type":"message","text":"ok"}'),
    ).toEqual({
      actions: [{ _type: "message", text: "ok" }],
    });
  });
});
