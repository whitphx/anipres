import { Editor, computed, type Atom } from "tldraw";
import { Frame, Step, getFrames, getFrameBatches } from "./models";
import { getGlobalOrder } from "./ordered-track-item";
import { AnimationController } from "./animation";

export class EditorSignals {
  public readonly animation: AnimationController;

  private constructor(
    private editor: Editor,
    $currentStepIndex: Atom<number>,
  ) {
    this.animation = new AnimationController(editor, this, $currentStepIndex);
  }

  private static instances: WeakMap<Editor, EditorSignals> = new WeakMap();

  static create(
    editor: Editor,
    $currentStepIndex: Atom<number>,
  ): EditorSignals {
    let inst = this.instances.get(editor);
    if (!inst) {
      inst = new EditorSignals(editor, $currentStepIndex);
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
