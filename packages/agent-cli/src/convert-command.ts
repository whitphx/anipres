import { readFile, writeFile } from "node:fs/promises";
import { convertLegacyVideoIdentityInSnapshot } from "anipres/models";

/**
 * Brings a stored snapshot up to the current media vocabulary, in
 * place unless told otherwise. Idempotent, so running it over a
 * directory of decks twice is harmless.
 */
export async function runConvertCommand(
  inputPath: string,
  outputPath: string,
): Promise<void> {
  const snapshot = JSON.parse(await readFile(inputPath, "utf-8"));
  const converted = convertLegacyVideoIdentityInSnapshot(snapshot);
  await writeFile(outputPath, JSON.stringify(converted, null, 2) + "\n");
}
