import { createShapeId, type Editor, type TLShapeId } from "tldraw";

/**
 * Per-request state passed to action utils on apply. Maps the agent's
 * freeform shape ids (whatever string the model chose) to actual tldraw
 * `shape:...` ids we minted on its behalf, so subsequent actions in the
 * same turn can refer back to shapes the agent just created.
 *
 * Two resolver methods because the call sites have different intents:
 *
 * - `resolveNewShapeId` mints a fresh id for a *new* shape (collision
 *   with an existing shape on the canvas means we hand back a random id
 *   instead of overwriting).
 * - `resolveExistingShapeId` looks up a shape that's already on the
 *   canvas (either one the agent created earlier this turn — cached —
 *   or one that came in with the snapshot, addressed by its real id).
 *   Returns `null` when no such shape exists.
 */
export class AgentHelpers {
  readonly editor: Editor;
  private readonly idMap = new Map<string, TLShapeId>();

  constructor(editor: Editor) {
    this.editor = editor;
  }

  /**
   * Mint a tldraw `shape:` id for a shape the agent is creating. Caches
   * the mapping so subsequent actions referring to the same agent id
   * (e.g. `attachCueFrame` on a freshly created shape) resolve to the
   * same real id.
   */
  resolveNewShapeId(agentId: string): TLShapeId {
    const cached = this.idMap.get(agentId);
    if (cached) return cached;

    const suffix = agentId.startsWith("shape:")
      ? agentId.slice("shape:".length)
      : agentId;
    let id = createShapeId(suffix || undefined);
    if (this.editor.getShape(id)) {
      // Collision with an existing shape — fall back to a random id so
      // we don't overwrite. The agent will see the new shape under the
      // new id in the next turn's perception.
      id = createShapeId();
    }
    this.idMap.set(agentId, id);
    return id;
  }

  /**
   * Look up the tldraw id of a shape the agent is referring to, either
   * one it created earlier this turn (cached mapping) or an existing
   * shape from the snapshot (addressed by its real `shape:...` id from
   * the perception layer). Returns `null` if no such shape is on the
   * canvas — the caller should treat this as a no-op or surface a
   * helpful error.
   */
  resolveExistingShapeId(agentId: string): TLShapeId | null {
    const cached = this.idMap.get(agentId);
    if (cached && this.editor.getShape(cached)) return cached;

    const direct = (
      agentId.startsWith("shape:") ? agentId : `shape:${agentId}`
    ) as TLShapeId;
    if (this.editor.getShape(direct)) return direct;

    return null;
  }
}
