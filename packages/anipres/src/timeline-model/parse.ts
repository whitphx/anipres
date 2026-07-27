// Soft-fail parsing of `shape.meta.frame`.
//
// Parsing NEVER throws: a malformed frame is reported as `invalid` (with a
// structured diagnostic downstream) instead of taking down rendering —
// without a diagnostic, a shape with corrupted animation metadata would be
// indistinguishable from a never-animated shape.

import type { JsonObject } from "tldraw";
import type { CueFrame, Frame, FrameAction, SubFrame } from "./types";
import { isReservedStepId } from "./ids";

// --- Legacy (v1) frame shapes, kept here so this module tree stays
// --- self-contained (no import from ../models).
export interface LegacyCueFrame {
  id: string;
  type: "cue";
  globalIndex: number;
  trackId: string;
  action: FrameAction;
}
export interface LegacySubFrame {
  id: string;
  type: "sub";
  prevFrameId: string;
  action: FrameAction;
}
export type LegacyFrame = LegacyCueFrame | LegacySubFrame;

export type ParsedFrameMeta =
  | { kind: "none" }
  | { kind: "v2"; frame: Frame }
  | { kind: "v1"; frame: LegacyFrame }
  | { kind: "invalid" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFrameAction(value: unknown): value is FrameAction {
  return isRecord(value) && typeof value.type === "string";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Parses the raw `shape.meta.frame` value. `none` means the shape carries
 * no animation data; `invalid` means it carries data we cannot interpret
 * (surfaced via an `invalid-frame` diagnostic by the derivation).
 */
export function parseFrameMeta(raw: unknown): ParsedFrameMeta {
  if (raw == null) {
    return { kind: "none" };
  }
  if (!isRecord(raw)) {
    return { kind: "invalid" };
  }

  if (raw.v === 2) {
    if (
      raw.type === "cue" &&
      isNonEmptyString(raw.id) &&
      isNonEmptyString(raw.trackId) &&
      isNonEmptyString(raw.stepId) &&
      // Persisted stepIds must never use the reserved derived-id namespace.
      !isReservedStepId(raw.stepId) &&
      isNonEmptyString(raw.stepOrderKey) &&
      isFrameAction(raw.action)
    ) {
      const frame: CueFrame = {
        v: 2,
        id: raw.id,
        type: "cue",
        trackId: raw.trackId,
        stepId: raw.stepId,
        stepOrderKey: raw.stepOrderKey,
        action: raw.action,
      };
      return { kind: "v2", frame };
    }
    if (
      raw.type === "sub" &&
      isNonEmptyString(raw.id) &&
      isNonEmptyString(raw.cueFrameId) &&
      isNonEmptyString(raw.orderKey) &&
      isFrameAction(raw.action)
    ) {
      const frame: SubFrame = {
        v: 2,
        id: raw.id,
        type: "sub",
        cueFrameId: raw.cueFrameId,
        orderKey: raw.orderKey,
        action: raw.action,
      };
      return { kind: "v2", frame };
    }
    return { kind: "invalid" };
  }

  // v1 frames are recognized by their fields and the absence of `v`.
  if ("v" in raw) {
    return { kind: "invalid" };
  }
  if (
    raw.type === "cue" &&
    isNonEmptyString(raw.id) &&
    typeof raw.globalIndex === "number" &&
    isNonEmptyString(raw.trackId) &&
    isFrameAction(raw.action)
  ) {
    return {
      kind: "v1",
      frame: {
        id: raw.id,
        type: "cue",
        globalIndex: raw.globalIndex,
        trackId: raw.trackId,
        action: raw.action,
      },
    };
  }
  if (
    raw.type === "sub" &&
    isNonEmptyString(raw.id) &&
    isNonEmptyString(raw.prevFrameId) &&
    isFrameAction(raw.action)
  ) {
    return {
      kind: "v1",
      frame: {
        id: raw.id,
        type: "sub",
        prevFrameId: raw.prevFrameId,
        action: raw.action,
      },
    };
  }
  return { kind: "invalid" };
}

/** Serializes a v2 frame back to the JSON stored in `shape.meta.frame`. */
export function frameToMetaJson(frame: Frame): JsonObject {
  if (frame.type === "cue") {
    const { v, id, type, trackId, stepId, stepOrderKey, action } = frame;
    return { v, id, type, trackId, stepId, stepOrderKey, action };
  }
  const { v, id, type, cueFrameId, orderKey, action } = frame;
  return { v, id, type, cueFrameId, orderKey, action };
}
