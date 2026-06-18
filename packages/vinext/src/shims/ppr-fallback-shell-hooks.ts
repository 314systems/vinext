import type { PprFallbackShellState } from "./ppr-fallback-shell.js";

type PprFallbackShellHooks = {
  createSuspensePromise<T>(expression: string): Promise<T> | null;
  createSuspensePromiseForState<T>(state: PprFallbackShellState, expression: string): Promise<T>;
  getState(): PprFallbackShellState | null;
  markDynamicBoundary(): void;
  trackCacheTask<T>(fn: () => Promise<T>, cacheVariant: string): Promise<T>;
};

const hooks: PprFallbackShellHooks = {
  createSuspensePromise: () => null,
  createSuspensePromiseForState: () => {
    throw new Error("[vinext] PPR fallback-shell runtime is not registered");
  },
  getState: () => null,
  markDynamicBoundary: () => {},
  trackCacheTask: (fn) => fn(),
};

export function registerPprFallbackShellHooks(implementations: PprFallbackShellHooks): void {
  Object.assign(hooks, implementations);
}

export function createPprFallbackShellSuspensePromiseForState<T>(
  state: PprFallbackShellState,
  expression: string,
): Promise<T> {
  return hooks.createSuspensePromiseForState<T>(state, expression);
}

export function createPprFallbackShellSuspensePromise<T>(expression: string): Promise<T> | null {
  return hooks.createSuspensePromise<T>(expression);
}

export function getPprFallbackShellState(): PprFallbackShellState | null {
  return hooks.getState();
}

export function markPprFallbackShellDynamicBoundary(): void {
  hooks.markDynamicBoundary();
}

export function trackPprFallbackShellCacheTask<T>(
  fn: () => Promise<T>,
  cacheVariant: string,
): Promise<T> {
  return hooks.trackCacheTask(fn, cacheVariant);
}
