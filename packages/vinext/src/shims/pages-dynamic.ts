/**
 * Client-safe registration surface for request-scoped Pages Router
 * next/dynamic module usage.
 */
let recordModuleIds = (_moduleIds: readonly string[] | undefined): void => {};
let readModuleIds = (): string[] | undefined => undefined;

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
