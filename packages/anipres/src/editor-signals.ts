import { Editor, computed } from "tldraw";
import { Frame, Step, getFrame, getFrameBatches } from "./models";
import { getGlobalOrder } from "./ordered-track-item";

export class EditorSignals {
  constructor(private editor: Editor) {}

  @computed getAllFrames(): Frame[] {
    const shapes = this.editor.getCurrentPageShapes();
    return shapes.map(getFrame).filter((frame) => frame != null);
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
