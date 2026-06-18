import type { FetchCacheMode } from "./fetch-cache.js";

type FetchCacheHooks = {
  addCollectedRequestTags(tags: readonly string[]): void;
  consumeDynamicFetchObservations(): string[];
  ensureFetchPatch(): void;
  getCollectedFetchTags(): string[];
  getCurrentFetchSoftTags(): string[];
  peekCacheableFetchObservations(): string[];
  peekDynamicFetchObservations(): string[];
  runWithFetchDedupe<T>(fn: () => T): T;
  setCurrentFetchCacheMode(mode: FetchCacheMode | null): void;
  setCurrentFetchSoftTags(tags: string[]): void;
  setCurrentForceDynamicFetchDefault(enabled: boolean): void;
};

const hooks: FetchCacheHooks = {
  addCollectedRequestTags: () => {},
  consumeDynamicFetchObservations: () => [],
  ensureFetchPatch: () => {},
  getCollectedFetchTags: () => [],
  getCurrentFetchSoftTags: () => [],
  peekCacheableFetchObservations: () => [],
  peekDynamicFetchObservations: () => [],
  runWithFetchDedupe: (fn) => fn(),
  setCurrentFetchCacheMode: () => {},
  setCurrentFetchSoftTags: () => {},
  setCurrentForceDynamicFetchDefault: () => {},
};

export function registerFetchCacheHooks(implementations: FetchCacheHooks): void {
  Object.assign(hooks, implementations);
}

export function addCollectedRequestTags(tags: readonly string[]): void {
  hooks.addCollectedRequestTags(tags);
}

export function consumeDynamicFetchObservations(): string[] {
  return hooks.consumeDynamicFetchObservations();
}

export function ensureFetchPatch(): void {
  hooks.ensureFetchPatch();
}

export function getCollectedFetchTags(): string[] {
  return hooks.getCollectedFetchTags();
}

export function getCurrentFetchSoftTags(): string[] {
  return hooks.getCurrentFetchSoftTags();
}

export function peekCacheableFetchObservations(): string[] {
  return hooks.peekCacheableFetchObservations();
}

export function peekDynamicFetchObservations(): string[] {
  return hooks.peekDynamicFetchObservations();
}

export function runWithFetchDedupe<T>(fn: () => T): T {
  return hooks.runWithFetchDedupe(fn);
}

export function setCurrentFetchCacheMode(mode: FetchCacheMode | null): void {
  hooks.setCurrentFetchCacheMode(mode);
}

export function setCurrentFetchSoftTags(tags: string[]): void {
  hooks.setCurrentFetchSoftTags(tags);
}

export function setCurrentForceDynamicFetchDefault(enabled: boolean): void {
  hooks.setCurrentForceDynamicFetchDefault(enabled);
}
