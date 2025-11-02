import { AnimationController } from "./animation";
import { EditorSignals } from "./editor-signals";

const INSTANCE_KEY = Symbol("instance");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function singletonize<T extends new (...args: any) => InstanceType<T>>(
  klass: T,
): (...args: ConstructorParameters<T>) => InstanceType<T> {
   
  type CacheMap = WeakMap<
    ConstructorParameters<T>[number] | symbol,
    CacheMap | InstanceType<T>
  >;
  const cache: CacheMap = new WeakMap();

  return (...args) => {
    let map = cache;
    for (const arg of args) {
      let nextMap = map.get(arg);
      if (!nextMap) {
        nextMap = new WeakMap();
        map.set(arg, nextMap);
      }
      map = nextMap as CacheMap;
    }

    const maybeInstance = map.get(INSTANCE_KEY);
    if (maybeInstance) {
      return maybeInstance as InstanceType<T>;
    }

    const instance = new klass(...args);
    map.set(INSTANCE_KEY, instance);
    return instance;
  };
}

export const getAnimationController = singletonize(AnimationController);

export const getEditorSignals = singletonize(EditorSignals);
