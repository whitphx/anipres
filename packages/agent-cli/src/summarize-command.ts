import { readFile } from "node:fs/promises";
import { loadHeadlessEditor } from "anipres";
import { getFrames, getFrameBatches, getGlobalOrder } from "anipres/models";

export async function runSummarizeCommand(inputPath: string): Promise<void> {
  const raw = await readFile(inputPath, "utf-8");
  const snapshot = JSON.parse(raw);

  const [editor, dispose] = loadHeadlessEditor({ snapshot });
  try {
    const shapes = editor.getCurrentPageShapes();
    const byType: Record<string, number> = {};
    for (const s of shapes) byType[s.type] = (byType[s.type] ?? 0) + 1;

    const frames = getFrames(shapes);
    const batches = getFrameBatches(frames);
    const ordered = getGlobalOrder(batches);

    process.stdout.write(`Snapshot: ${inputPath}\n`);
    process.stdout.write(`Shapes: ${shapes.length}\n`);
    process.stdout.write(
      `By type: ${Object.entries(byType)
        .map(([t, n]) => `${t}=${n}`)
        .join(", ")}\n`,
    );
    process.stdout.write(`Frames: ${frames.length}\n`);
    process.stdout.write(`Steps: ${ordered.length}\n`);

    if (ordered.length === 0) return;

    process.stdout.write(`\nStep summary:\n`);
    ordered.forEach((step, i) => {
      const summary = step
        .map((b) => {
          const head = b.data[0];
          const dur = head.action.duration ?? "-";
          return `track=${b.trackId.slice(0, 12)} action=${head.action.type} dur=${dur} (${b.data.length} frames)`;
        })
        .join("; ");
      process.stdout.write(`  step ${i}: ${summary}\n`);
    });
  } finally {
    dispose();
  }
}
