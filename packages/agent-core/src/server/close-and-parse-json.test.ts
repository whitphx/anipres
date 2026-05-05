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

  it("closes an unterminated string inside an array element", () => {
    // The string value is left open mid-token; the closer should append
    // `"`, `}`, `]`, `}` to recover a parseable action array.
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

  it('treats a `"` after an even run of backslashes as a string close', () => {
    // `{"text":"a\\"}` — the JSON value is `a\` (the `\\` decodes
    // to one backslash). The closing `"` is genuinely closing, not
    // escaped, so the parser must NOT keep the string open.
    expect(closeAndParseJson('{"text":"a\\\\"}')).toEqual({ text: "a\\" });
  });

  it('keeps treating a `"` after an odd run of backslashes as escaped', () => {
    // `{"text":"a\\\"` — the value is `a\"` (backslash + quote);
    // string is still open after the escaped `"`. Closing should
    // append `"` then `}` and produce `{text: 'a\\"'}` (backslash
    // followed by quote, i.e. JS string `a\\"`, JSON `"a\\\""`).
    expect(closeAndParseJson('{"text":"a\\\\\\"')).toEqual({
      text: 'a\\"',
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
