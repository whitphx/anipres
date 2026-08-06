// Animation Data Model v2 — core types.
// Spec: docs/design-animation-data-model.md
//
// This module tree (src/timeline-model/) is self-contained: it never
// imports from ../models (the v1 surface), so the v1 module can later
// re-export from here without a cycle.

import type { EASINGS } from "tldraw";
import type { JsonObject } from "tldraw";
import type { OrderKey } from "./order-key";

/**
 * The animation-metadata format this build reads AND writes. v1 input
 * is recognized but never converted (surfaced as a `v1-frame`
 * diagnostic; design doc r9).
 *
 * ROLLOUT GATE (spec: docs/design-animation-data-model.md, Risk 6):
 * tldraw's store schema versioning does not cover `meta` contents, so
 * the sync layer enforces a minimum client version against this
 * constant — a v1-era writer would silently revert newer ordering.
 */
export const TIMELINE_FORMAT_VERSION = 2;

export interface FrameActionBase extends JsonObject {
  type: string;
}
export interface ShapeAnimationFrameAction extends FrameActionBase {
  type: "shapeAnimation";
  duration?: number;
  easing?: keyof typeof EASINGS;
}
export interface CameraZoomFrameAction extends FrameActionBase {
  type: "cameraZoom";
  inset?: number;
  duration?: number;
  easing?: keyof typeof EASINGS;
}
export const MEDIA_CONTROL_COMMANDS = [
  "play",
  "pause",
  "stop",
  "mute",
  "unmute",
  "setVolume",
] as const;
export type MediaControlCommand = (typeof MEDIA_CONTROL_COMMANDS)[number];

/**
 * Fires a playback command against the media shape the frame's marker
 * is bound to. `duration` is the wait
 * before the batch's next frame runs, not an animation length — the
 * command itself is instantaneous.
 */
export interface MediaControlFrameAction extends FrameActionBase {
  type: "mediaControl";
  command: MediaControlCommand;
  duration?: number;
  /** setVolume only: absolute volume, 0–100. */
  volume?: number;
}

export type FrameAction =
  | ShapeAnimationFrameAction
  | CameraZoomFrameAction
  | MediaControlFrameAction;

/**
 * v2 cue frame — triggered by the user's "next" action.
 * Cue frames sharing a `stepId` are *intentionally* simultaneous (one step).
 * `stepOrderKey` is a fractional index key giving the step's position;
 * key coincidence has NO grouping meaning.
 */
export interface CueFrame<T extends FrameAction = FrameAction> {
  v: 2;
  id: string;
  type: "cue";
  trackId: string;
  stepId: string;
  stepOrderKey: OrderKey;
  action: T;
}

/**
 * v2 sub frame — auto-chained after its batch's preceding frames.
 * `cueFrameId` is batch membership (the id of the batch's cue frame),
 * not chain position; `orderKey` orders sub frames within the batch.
 */
export interface SubFrame<T extends FrameAction = FrameAction> {
  v: 2;
  id: string;
  type: "sub";
  cueFrameId: string;
  orderKey: OrderKey;
  action: T;
}

export type Frame<T extends FrameAction = FrameAction> =
  | CueFrame<T>
  | SubFrame<T>;

/** A frame together with the shape record that carries it. */
export interface ShapeFrame {
  shapeId: string;
  frame: Frame;
}

// ---------------------------------------------------------------------------
// Derived output — TimelineDoc. Not a source of truth; the versioned output
// type of the derivation pipeline (and the future compiled-export format).
// ---------------------------------------------------------------------------

export interface FrameData {
  /** The stored frame id — data that duplicate-id corruption can affect. */
  frameId: string;
  /** The carrying shape's id — the identity tldraw guarantees unique. */
  shapeId: string;
  action: FrameAction;
}

export interface BatchData {
  trackId: string;
  /** frames[0] is the cue; the rest are sub frames in batch order. */
  frames: FrameData[];
}

export interface StepData {
  /**
   * For a normal step: the stored stepId (stable identity across reorders).
   * For a rule-2 recovery step: a deterministic derived id (see
   * `makeSyntheticStepId`); `synthetic` is set in that case.
   */
  id: string;
  /** Canonical stepOrderKey of the step (the representative member's key). */
  orderKey: OrderKey;
  batches: BatchData[];
  /** Present ONLY on rule-2 recovery steps. */
  synthetic?: {
    reason: "same-track-split";
    sourceStepId: string;
  };
}

export type TimelineDiagnostic =
  | { type: "step-key-divergence"; stepId: string; shapeIds: string[] }
  | {
      type: "same-track-split";
      stepId: string;
      trackId: string;
      shapeIds: string[];
    }
  | { type: "detached-sub-frame"; shapeId: string; cueFrameId: string }
  | { type: "duplicate-frame-id"; frameId: string; shapeIds: string[] }
  | { type: "invalid-frame"; shapeId: string }
  /**
   * The listed shapes carry v1 animation data. Read-time conversion was
   * removed after the one-time batch migration of all known documents
   * (design doc r9); the records are surfaced, not animated. One
   * diagnostic per document — an unconverted v1 deck has many such
   * shapes, and a per-shape entry would flood the panel.
   */
  | { type: "v1-frame"; shapeIds: string[] };

export interface TimelineDoc {
  version: 1;
  /** Array order = presentation order. */
  steps: StepData[];
  /** Rule-3 orphans (dangling `cueFrameId`) — surfaced, never dropped. */
  detachedFrames: FrameData[];
  diagnostics: TimelineDiagnostic[];
}

// ---------------------------------------------------------------------------
// Structural editing interchange — what UI mutations (Timeline drag & drop,
// ControlPanel operations) produce; reconciled back into per-shape v2 metas.
// ---------------------------------------------------------------------------

export interface EditedFrameRef {
  /**
   * The carrying shape's id — the identity edits are keyed by (unique by
   * tldraw's guarantee, unlike stored frame ids, which duplicate-id
   * corruption can collide).
   */
  shapeId: string;
  /** The stored frame id — relationship data and diagnostics only. */
  frameId: string;
  action: FrameAction;
}
export interface EditedBatch {
  trackId: string;
  /** frames[0] takes the cue role; the rest become sub frames, in order. */
  frames: EditedFrameRef[];
}
/**
 * Identity of the derived doc step an edited step DISPLAYS. Carried so
 * reconciliation can tell a stored step, a rule-2 synthetic recovery
 * step, and a newly created step apart — without it, ordinary drags of
 * UNRELATED steps would silently persist semantic repairs (converging
 * divergent keys, materializing same-track splits) that the design
 * reserves for explicit diagnostic resolution.
 */
export interface EditedStepSource {
  /** The doc step id (stored stepId, or a reserved synthetic id). */
  id: string;
  /** The doc step's canonical order key. */
  orderKey: OrderKey;
  /** Present iff the source step is a rule-2 recovery step. */
  synthetic?: {
    reason: "same-track-split";
    sourceStepId: string;
  };
}
/** One presentation step: batches that fire simultaneously. */
export interface EditedStep {
  batches: EditedBatch[];
  /** Source doc step identity; absent for steps the edit created. */
  source?: EditedStepSource;
}
