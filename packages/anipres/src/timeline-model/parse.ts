// Soft-fail parsing of `shape.meta.frame`.
//
// Parsing NEVER throws — and it is the single place malformed data is
// rejected, so the derivation downstream cannot throw on reachable
// input. A malformed frame is reported as `invalid` (with a
// structured diagnostic downstream) instead of taking down rendering —
// without a diagnostic, a shape with corrupted animation metadata would be
// indistinguishable from a never-animated shape.

import { EASINGS } from "tldraw";
import type { JsonObject } from "tldraw";
import type { CueFrame, Frame, FrameAction, SubFrame } from "./types";
import { MEDIA_CONTROL_COMMANDS } from "./types";
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

export interface ParseFrameMetaOptions {
  /**
   * Accept cue frames whose `stepId` carries the reserved `synthstep:`
   * prefix. ONLY for copy/paste preprocessing, which must be able to read
   * such (invalid-as-persisted) frames in order to freshen them — a pasted
   * cue carrying a reserved id receives a fresh normal `stepId`. Normal
   * document parsing rejects them as `invalid`.
   */
  allowReservedStepId?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Strict action validation: only the known action types; numeric fields
 * must be finite numbers; `easing` must be a recognized tldraw easing;
 * `inset` is cameraZoom-only; `command`/`volume` are mediaControl-only
 * (`volume` further restricted to the setVolume command, 0–100).
 * Anything else is malformed.
 */
function parseFrameAction(value: unknown): FrameAction | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    value.type !== "shapeAnimation" &&
    value.type !== "cameraZoom" &&
    value.type !== "mediaControl"
  ) {
    return null;
  }
  if (value.duration !== undefined && !isFiniteNumber(value.duration)) {
    return null;
  }
  if (value.type === "mediaControl") {
    if (value.easing !== undefined || value.inset !== undefined) {
      return null;
    }
    if (
      typeof value.command !== "string" ||
      !(MEDIA_CONTROL_COMMANDS as readonly string[]).includes(value.command)
    ) {
      return null;
    }
    if (value.command === "setVolume") {
      if (
        value.volume !== undefined &&
        (!isFiniteNumber(value.volume) ||
          value.volume < 0 ||
          value.volume > 100)
      ) {
        return null;
      }
    } else if (value.volume !== undefined) {
      return null;
    }
    return value as FrameAction;
  }
  if (
    value.easing !== undefined &&
    (typeof value.easing !== "string" || !(value.easing in EASINGS))
  ) {
    return null;
  }
  if (value.type === "cameraZoom") {
    if (value.inset !== undefined && !isFiniteNumber(value.inset)) {
      return null;
    }
  } else if (value.inset !== undefined) {
    return null;
  }
  if (value.command !== undefined || value.volume !== undefined) {
    return null;
  }
  return value as FrameAction;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Parses the raw `shape.meta.frame` value. `none` means the shape carries
 * no animation data; `invalid` means it carries data we cannot interpret
 * (surfaced via an `invalid-frame` diagnostic by the derivation).
 */
export function parseFrameMeta(
  raw: unknown,
  options?: ParseFrameMetaOptions,
): ParsedFrameMeta {
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
      // Persisted stepIds must never use the reserved derived-id
      // namespace (paste preprocessing opts in to read-and-freshen them).
      (options?.allowReservedStepId === true ||
        !isReservedStepId(raw.stepId)) &&
      isNonEmptyString(raw.stepOrderKey)
    ) {
      const action = parseFrameAction(raw.action);
      if (action == null) {
        return { kind: "invalid" };
      }
      const frame: CueFrame = {
        v: 2,
        id: raw.id,
        type: "cue",
        trackId: raw.trackId,
        stepId: raw.stepId,
        stepOrderKey: raw.stepOrderKey,
        action,
      };
      return { kind: "v2", frame };
    }
    if (
      raw.type === "sub" &&
      isNonEmptyString(raw.id) &&
      isNonEmptyString(raw.cueFrameId) &&
      isNonEmptyString(raw.orderKey)
    ) {
      const action = parseFrameAction(raw.action);
      if (action == null) {
        return { kind: "invalid" };
      }
      const frame: SubFrame = {
        v: 2,
        id: raw.id,
        type: "sub",
        cueFrameId: raw.cueFrameId,
        orderKey: raw.orderKey,
        action,
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
    // v1 never produced non-integer or negative indexes; anything else
    // is corruption.
    typeof raw.globalIndex === "number" &&
    Number.isSafeInteger(raw.globalIndex) &&
    raw.globalIndex >= 0 &&
    isNonEmptyString(raw.trackId)
  ) {
    const action = parseFrameAction(raw.action);
    if (action == null) {
      return { kind: "invalid" };
    }
    return {
      kind: "v1",
      frame: {
        id: raw.id,
        type: "cue",
        globalIndex: raw.globalIndex,
        trackId: raw.trackId,
        action,
      },
    };
  }
  if (
    raw.type === "sub" &&
    isNonEmptyString(raw.id) &&
    isNonEmptyString(raw.prevFrameId)
  ) {
    const action = parseFrameAction(raw.action);
    if (action == null) {
      return { kind: "invalid" };
    }
    return {
      kind: "v1",
      frame: {
        id: raw.id,
        type: "sub",
        prevFrameId: raw.prevFrameId,
        action,
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
