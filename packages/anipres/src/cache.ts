import { AnimationController } from "./animation";
import { EditorSignals } from "./editor-signals";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const controllerCache = new WeakMap<any, any>();
const INSTANCE_KEY = Symbol("instance");

export function getAnimationController(
  ...args: ConstructorParameters<typeof AnimationController>
): AnimationController {
  let map = controllerCache;
  for (const arg of args) {
    if (!map.has(arg)) map.set(arg, new WeakMap());
    map = map.get(arg);
  }

  if (map.has(INSTANCE_KEY)) {
    return map.get(INSTANCE_KEY) as AnimationController;
  }

  const instance = new AnimationController(...args);
  map.set(INSTANCE_KEY, instance);
  return instance;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const editorSignalsCache = new WeakMap<any, any>();
export function getEditorSignals(
  ...args: ConstructorParameters<typeof EditorSignals>
): EditorSignals {
  let map = editorSignalsCache;
  for (const arg of args) {
    if (!map.has(arg)) map.set(arg, new WeakMap());
    map = map.get(arg);
  }

  if (map.has(INSTANCE_KEY)) {
    return map.get(INSTANCE_KEY) as EditorSignals;
  }

  const instance = new EditorSignals(...args);
  map.set(INSTANCE_KEY, instance);
  return instance;
}
