import { createShapeId, type Editor, type TLShapeId } from "tldraw";

/**
 * Per-request state passed to action utils on apply. Maps the agent's
 * freeform shape ids (whatever string the model chose) to actual tldraw
 * `shape:...` ids we minted on its behalf, so subsequent actions in the
 * same turn can refer back to shapes the agent just created.
 */
export class AgentHelpers {
  readonly editor: Editor;
  private readonly idMap = new Map<string, TLShapeId>();

  constructor(editor: Editor) {
    this.editor = editor;
  }

  /**
   * Resolve an agent-supplied id to a tldraw `shape:` id. Returns the
   * previously-minted id if the agent has referenced this string before; on
   * a collision with an existing shape, falls back to a randomised id.
   */
  resolveShapeId(agentId: string): TLShapeId {
    const cached = this.idMap.get(agentId);
    if (cached) return cached;

    let id = createShapeId(safeSuffix(agentId));
    if (this.editor.getShape(id)) {
      id = createShapeId();
    }
    this.idMap.set(agentId, id);
    return id;
  }
}

function safeSuffix(s: string): string {
  const stripped = s.startsWith("shape:") ? s.slice("shape:".length) : s;
  return stripped.slice(0, 32) || "agent";
}
