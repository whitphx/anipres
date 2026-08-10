import { readFile, writeFile } from "node:fs/promises";
import { convertLegacyVideoIdentityInSnapshot } from "anipres";
import { installDomGlobals } from "@anipres/agent-core/runtime";

/**
 * Brings a stored snapshot up to the current media vocabulary, in
 * place unless told otherwise. Idempotent, so running it over a
 * directory of decks twice is harmless.
 */
export async function runConvertCommand(
  inputPath: string,
  outputPath: string,
): Promise<void> {
  // The conversion runs a headless editor, which tldraw builds against
  // a DOM; every other command that loads a snapshot does the same.
  installDomGlobals();
  const snapshot = JSON.parse(await readFile(inputPath, "utf-8"));
  const converted = convertLegacyVideoIdentityInSnapshot(snapshot);
  await writeFile(outputPath, JSON.stringify(converted, null, 2) + "\n");
}
