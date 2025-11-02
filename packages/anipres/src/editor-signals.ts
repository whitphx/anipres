import { Editor, computed } from "tldraw";
import { Frame, Step, getFrames, getFrameBatches } from "./models";
import { getGlobalOrder } from "./ordered-track-item";

export class EditorSignals {
  private constructor(private editor: Editor) {}

  private static instances: WeakMap<Editor, EditorSignals> = new WeakMap();

  static create(editor: Editor): EditorSignals {
    let inst = this.instances.get(editor);
    if (!inst) {
      inst = new EditorSignals(editor);
      this.instances.set(editor, inst);
    }
    return inst;
  }

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
