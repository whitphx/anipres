import { Editor, computed } from "tldraw";
import { Frame, Step, getFrames, getFrameBatches } from "./models";
import { getGlobalOrder } from "./ordered-track-item";
import { singletonInitializerOf } from "./cache";

class _EditorSignals {
  constructor(private editor: Editor) {}

  @computed getAllFrames(): Frame[] {
    const shapes = this.editor.getCurrentPageShapes();
    return getFrames(shapes);
  }

  @computed getOrderedSteps(): Step[] {
    const frames = this.getAllFrames();
    const frameBatches = getFrameBatches(frames);
    const orderedSteps = getGlobalOrder(frameBatches);
    return orderedSteps;
  }

  @computed getTotalSteps(): number {
    return this.getOrderedSteps().length;
  }
}

export const getEditorSignals = singletonInitializerOf(_EditorSignals);
export type EditorSignals = _EditorSignals;
