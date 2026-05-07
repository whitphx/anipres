// Largely a port of `worker/do/closeAndParseJson.ts` from tldraw/
// agent-template (MIT, © 2024 tldraw Inc.) — same algorithm, same
// stack representation, same JSON.parse-or-null contract. The
// changes here are stylistic (TypeScript types, a for-loop instead
// of a while-i++) plus one behavioural fix: counting consecutive
// backslashes when detecting an escaped `"`, so a string ending in
// an escaped backslash (`\\"`) doesn't trap the parser inside a
// string forever. See THIRD_PARTY_NOTICES.md at the repo root.
/**
 * Given a potentially-incomplete JSON string, append closing braces, brackets,
 * and quotation marks until it parses, then return the parsed value.
 *
 * Used to render in-flight action data while the model is still streaming the
 * JSON for it. The grammar we expect is narrow (`{"actions":[{...}, ...]}`)
 * so this stack-based closer is sufficient.
 *
 * Returns `null` if the result still doesn't parse — the caller is expected to
 * skip that chunk and try again on the next one.
 */
export function closeAndParseJson(input: string): unknown {
  let s = input;
  const stack: Array<"{" | "[" | '"'> = [];
  // Position immediately after the most recent point at which the
  // structure stack returned to empty (i.e. the end of a top-level
  // JSON value). When the model wraps its response — e.g. in a
  // markdown code fence — there's content trailing the balanced
  // JSON; we use this index to slice that off before parsing.
  let topLevelClosedAt = -1;
  let topLevelDepth = 0;

  for (let i = 0; i < s.length; i++) {
    const top = stack.at(-1);
    const ch = s[i];

    if (ch === '"') {
      // A `"` is escaped iff the immediately preceding run of
      // backslashes has odd length: `\"` escapes, `\\"` does not
      // (the `\\` is the escaped backslash and the `"` closes the
      // string), `\\\"` does, and so on. The previous one-char
      // check (`s[i-1] === "\\"`) wrongly treated `\\"` as escaped
      // — so a string ending in an escaped backslash kept the
      // parser inside the string forever, the rest of the buffer
      // was eaten as string content, and `JSON.parse` failed,
      // silently dropping every action that arrived after.
      let backslashes = 0;
      for (let j = i - 1; j >= 0 && s[j] === "\\"; j--) backslashes++;
      if (backslashes % 2 === 1) continue;
      if (top === '"') stack.pop();
      else stack.push('"');
      continue;
    }

    if (top === '"') continue;

    if (ch === "{" || ch === "[") {
      stack.push(ch);
      topLevelDepth++;
    } else if (ch === "}" && top === "{") {
      stack.pop();
      topLevelDepth--;
      if (topLevelDepth === 0) topLevelClosedAt = i + 1;
    } else if (ch === "]" && top === "[") {
      stack.pop();
      topLevelDepth--;
      if (topLevelDepth === 0) topLevelClosedAt = i + 1;
    }
  }

  if (topLevelClosedAt !== -1 && topLevelClosedAt < s.length) {
    // A complete top-level JSON value ended before the buffer did.
    // Slice off the trailing content so JSON.parse doesn't choke on
    // it (e.g. the closing `\`\`\`` of a markdown code fence).
    s = s.slice(0, topLevelClosedAt);
  } else {
    for (let i = stack.length - 1; i >= 0; i--) {
      const opening = stack[i];
      if (opening === "{") s += "}";
      else if (opening === "[") s += "]";
      else if (opening === '"') s += '"';
    }
  }

  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
