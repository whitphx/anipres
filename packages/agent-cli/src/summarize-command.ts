import { readFile } from "node:fs/promises";
import {
  formatSnapshotSummary,
  summarizeSnapshot,
} from "@anipres/agent-core/runtime";

export async function runSummarizeCommand(inputPath: string): Promise<void> {
  const raw = await readFile(inputPath, "utf-8");
  const snapshot = JSON.parse(raw);
  const summary = summarizeSnapshot(snapshot);
  process.stdout.write(formatSnapshotSummary(inputPath, summary) + "\n");
}
