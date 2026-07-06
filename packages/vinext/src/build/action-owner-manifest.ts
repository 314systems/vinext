import type { AppRoute } from "../routing/app-route-graph.js";
import { safeJsonStringify } from "../server/html.js";

type ActionOwnerRoute = Pick<
  AppRoute,
  | "errorPath"
  | "errorPaths"
  | "forbiddenPath"
  | "forbiddenPaths"
  | "layoutErrorPaths"
  | "layouts"
  | "loadingPath"
  | "notFoundPath"
  | "notFoundPaths"
  | "pagePath"
  | "parallelSlots"
  | "pattern"
  | "siblingIntercepts"
  | "templates"
  | "unauthorizedPath"
  | "unauthorizedPaths"
>;

type ServerReferenceMeta = {
  exportNames: readonly string[];
  importId: string;
  referenceKey: string;
};

type ModuleInfoProvider = {
  getModuleInfo(id: string): {
    dynamicImportedIds?: readonly string[];
    importedIds: readonly string[];
  } | null;
};

export function actionOwnerRouteEntryIds(route: ActionOwnerRoute): string[] {
  return [
    route.pagePath,
    ...route.layouts,
    ...route.templates,
    route.loadingPath,
    route.errorPath,
    ...(route.layoutErrorPaths ?? []),
    ...(route.errorPaths ?? []),
    route.notFoundPath,
    ...(route.notFoundPaths ?? []),
    route.forbiddenPath,
    ...(route.forbiddenPaths ?? []),
    route.unauthorizedPath,
    ...(route.unauthorizedPaths ?? []),
    ...route.parallelSlots.flatMap((slot) => [
      slot.pagePath,
      slot.defaultPath,
      slot.layoutPath,
      ...(slot.configLayoutPaths ?? []),
      slot.loadingPath,
      slot.errorPath,
      ...slot.interceptingRoutes.flatMap((intercept) => [
        intercept.pagePath,
        ...intercept.layoutPaths,
      ]),
    ]),
    ...route.siblingIntercepts.flatMap((intercept) => [
      intercept.pagePath,
      ...intercept.layoutPaths,
    ]),
  ].filter((value): value is string => typeof value === "string");
}

function addOwner(manifest: Record<string, string[]>, key: string, pattern: string): void {
  const owners = (manifest[key] ??= []);
  if (!owners.includes(pattern)) owners.push(pattern);
}

export function buildActionOwnerManifest(options: {
  canonicalizeModuleId?: (id: string) => string;
  moduleInfo: ModuleInfoProvider;
  routes: readonly ActionOwnerRoute[];
  serverReferenceConsumers: Readonly<Record<string, readonly string[]>>;
  serverReferences: readonly ServerReferenceMeta[];
}): Record<string, string[]> {
  const manifest: Record<string, string[]> = {};
  const canonicalizeModuleId = options.canonicalizeModuleId ?? ((id: string) => id);

  for (const route of options.routes) {
    const entryIds = actionOwnerRouteEntryIds(route);
    const routeComponentIds = new Set(entryIds.map(canonicalizeModuleId));
    const reachableIds = new Set(routeComponentIds);
    const queue = [...routeComponentIds];
    for (let index = 0; index < queue.length; index++) {
      const info = options.moduleInfo.getModuleInfo(queue[index]!);
      for (const importedId of [
        ...(info?.importedIds ?? []),
        ...(info?.dynamicImportedIds ?? []),
      ]) {
        const canonicalImportedId = canonicalizeModuleId(importedId);
        if (reachableIds.has(canonicalImportedId)) continue;
        reachableIds.add(canonicalImportedId);
        queue.push(canonicalImportedId);
      }
    }

    const consumedActions = new Set<string>();
    for (const reachableId of reachableIds) {
      for (const actionId of options.serverReferenceConsumers[reachableId] ?? []) {
        consumedActions.add(actionId);
      }
    }

    for (const reference of options.serverReferences) {
      const referenceId = canonicalizeModuleId(reference.importId);
      const isRouteComponent = routeComponentIds.has(referenceId);
      if (isRouteComponent) addOwner(manifest, reference.referenceKey, route.pattern);
      for (const exportName of reference.exportNames) {
        const actionId = `${reference.referenceKey}#${exportName}`;
        if (isRouteComponent || consumedActions.has(actionId)) {
          addOwner(manifest, actionId, route.pattern);
        }
      }
    }
  }

  return manifest;
}

export function injectActionOwnerManifest(
  code: string,
  manifest: Record<string, string[]>,
): string | null {
  const marker =
    /function\s+([\w$]+)\(\)\s*\{\s*return\s*["'`]__VINEXT_ACTION_OWNERS_STUB__["'`];?\s*\}/;
  const match = code.match(marker);
  if (!match) return null;
  return code.replace(
    marker,
    () => `function ${match[1]}() { return ${safeJsonStringify(manifest)}; }`,
  );
}
