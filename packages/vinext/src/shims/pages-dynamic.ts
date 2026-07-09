/**
 * Client-safe registration surface for request-scoped Pages Router
 * next/dynamic module usage.
 */
let recordModuleIds = (_moduleIds: readonly string[] | undefined): void => {};
let readModuleIds = (): string[] | undefined => undefined;
const clientInitializers = new Map<string, Set<() => Promise<unknown>>>();
let clientPreloadFinished = false;
let clientPreloadPromise: Promise<void> | undefined;

export function _registerPagesDynamicStateAccessors(accessors: {
  recordPagesDynamicModuleIds: (moduleIds: readonly string[] | undefined) => void;
  getPagesDynamicModuleIds: () => string[] | undefined;
}): void {
  recordModuleIds = accessors.recordPagesDynamicModuleIds;
  readModuleIds = accessors.getPagesDynamicModuleIds;
}

export function recordPagesDynamicModuleIds(moduleIds: readonly string[] | undefined): void {
  recordModuleIds(moduleIds);
}

export function getPagesDynamicModuleIds(): string[] | undefined {
  return readModuleIds();
}

export function registerPagesDynamicInitializer(
  moduleIds: readonly string[] | undefined,
  initializer: () => Promise<unknown>,
): void {
  if (typeof window === "undefined" || clientPreloadFinished || !moduleIds) return;
  for (const moduleId of moduleIds) {
    let initializers = clientInitializers.get(moduleId);
    if (!initializers) {
      initializers = new Set();
      clientInitializers.set(moduleId, initializers);
    }
    initializers.add(initializer);
  }
}

export async function preloadPagesDynamicModules(
  moduleIds: readonly (string | number)[] = [],
): Promise<void> {
  if (clientPreloadPromise) return clientPreloadPromise;

  const requestedIds = new Set(moduleIds.map(String));
  clientPreloadPromise = (async () => {
    do {
      const initializers = Array.from(clientInitializers.entries());
      clientInitializers.clear();
      const pending = new Set<Promise<unknown>>();
      for (const [moduleId, moduleInitializers] of initializers) {
        if (!requestedIds.has(moduleId)) continue;
        for (const initializer of moduleInitializers) {
          pending.add(initializer());
        }
      }
      await Promise.all(Array.from(pending, (promise) => promise.catch(() => undefined)));
    } while (clientInitializers.size > 0);
    clientPreloadFinished = true;
  })();

  try {
    await clientPreloadPromise;
  } finally {
    if (!clientPreloadFinished) {
      clientPreloadPromise = undefined;
    }
  }
}

if (typeof window !== "undefined") {
  window.__NEXT_PRELOADREADY = preloadPagesDynamicModules;
}
