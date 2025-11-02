const INSTANCE_KEY = Symbol("instance");

export function singletonInitializerOf<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  T extends new (...args: any) => InstanceType<T>,
>(Class: T): (...args: ConstructorParameters<T>) => InstanceType<T> {
  type CacheMap = WeakMap<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any,
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

    const instance = new Class(...args);
    map.set(INSTANCE_KEY, instance);
    return instance;
  };
}
