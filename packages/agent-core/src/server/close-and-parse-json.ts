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

  for (let i = 0; i < s.length; i++) {
    const top = stack.at(-1);
    const ch = s[i];

    if (ch === '"') {
      if (i > 0 && s[i - 1] === "\\") continue;
      if (top === '"') stack.pop();
      else stack.push('"');
      continue;
    }

    if (top === '"') continue;

    if (ch === "{" || ch === "[") {
      stack.push(ch);
    } else if (ch === "}" && top === "{") {
      stack.pop();
    } else if (ch === "]" && top === "[") {
      stack.pop();
    }
  }

  for (let i = stack.length - 1; i >= 0; i--) {
    const opening = stack[i];
    if (opening === "{") s += "}";
    else if (opening === "[") s += "]";
    else if (opening === '"') s += '"';
  }

  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
