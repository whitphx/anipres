import { loadHeadlessEditor } from "anipres";
import {
  getFrames,
  getFrameBatches,
  getGlobalOrder,
  type FrameAction,
} from "anipres/models";
import type { SnapshotInput } from "./edit-snapshot.js";
import { installDomGlobals } from "./install-dom-globals.js";

export interface SnapshotSummary {
  shapes: number;
  byType: Record<string, number>;
  frames: number;
  totalSteps: number;
  steps: Array<{
    index: number;
    batches: Array<{
      trackId: string;
      action: FrameAction;
      frameCount: number;
    }>;
  }>;
}

/**
 * Pure function: load a snapshot and return its presentation summary.
 * No I/O beyond the editor lifecycle. Used by the CLI's summarize
 * subcommand, the MCP summarize tool, and any other Node-side host
 * that needs to peek at a snapshot's structure.
 */
export function summarizeSnapshot(snapshot: SnapshotInput): SnapshotSummary {
  // See editSnapshot for why the install is needed before
  // loadHeadlessEditor is called.
  installDomGlobals();
  const [editor, dispose] = loadHeadlessEditor({ snapshot });
  try {
    const shapes = editor.getCurrentPageShapes();
    const byType: Record<string, number> = {};
    for (const s of shapes) byType[s.type] = (byType[s.type] ?? 0) + 1;

    const frames = getFrames(shapes);
    const batches = getFrameBatches(frames);
    const ordered = getGlobalOrder(batches);

    return {
      shapes: shapes.length,
      byType,
      frames: frames.length,
      totalSteps: ordered.length,
      steps: ordered.map((step, i) => ({
        index: i,
        batches: step.map((b) => ({
          trackId: b.trackId,
          action: b.data[0].action,
          frameCount: b.data.length,
        })),
      })),
    };
  } finally {
    dispose();
  }
}

export function formatSnapshotSummary(
  inputPath: string,
  s: SnapshotSummary,
): string {
  const lines: string[] = [];
  lines.push(`Snapshot: ${inputPath}`);
  lines.push(`Shapes: ${s.shapes}`);
  lines.push(
    `By type: ${Object.entries(s.byType)
      .map(([t, n]) => `${t}=${n}`)
      .join(", ")}`,
  );
  lines.push(`Frames: ${s.frames}`);
  lines.push(`Steps: ${s.totalSteps}`);

  if (s.totalSteps > 0) {
    lines.push("");
    lines.push("Step summary:");
    for (const step of s.steps) {
      const batchSummary = step.batches
        .map(
          (b) =>
            `track=${b.trackId.slice(0, 12)} action=${b.action.type} dur=${b.action.duration ?? "-"} (${b.frameCount} frames)`,
        )
        .join("; ");
      lines.push(`  step ${step.index}: ${batchSummary}`);
    }
  }
  return lines.join("\n");
}
