/**
 * The `type` a frame's own place within its batch carries in its
 * droppable data, as opposed to the `"at"` / `"after"` of the step-level
 * targets around it. A drop here reorders inside the batch instead of
 * moving the frame between steps, which the collision rules, the drop
 * handler and the drag preview each have to tell apart.
 *
 * Shared because dnd-kit types droppable data as `Record<string, any>`,
 * so a misspelling at any one of those sites is not a type error: it
 * silently reads as "not a reorder" and the site goes back to its old
 * behaviour.
 */
export const WITHIN_DROP_TYPE = "within";
