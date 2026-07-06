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

type ServerReferenceModuleEdge = {
  exportNames: readonly string[] | "*";
  exportedName?: string;
  sourceId: string;
};

type ServerReferenceModuleEdges = {
  imports: readonly ServerReferenceModuleEdge[];
  reexports: readonly ServerReferenceModuleEdge[];
};

type ScanImport = {
  d: number;
  n?: string;
  s: number;
  se: number;
  ss: number;
};

type ScanExport = {
  ln?: string;
  n: string;
};

type ScanModuleInfo = {
  dynamicallyImportedIds: readonly string[];
  id: string;
  importedIds: readonly string[];
};

export type ActionOwnerScanEvent =
  | { environmentName: string; type: "reset" }
  | {
      code: string;
      environmentName: string;
      exports: readonly ScanExport[];
      info: ScanModuleInfo;
      imports: readonly ScanImport[];
      type: "module";
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

function splitCommaSeparated(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quote = "";
  let escaped = false;
  for (let index = 0; index < value.length; index++) {
    const character = value[index]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === ",") {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
}

function unquoteExportName(value: string): string {
  const trimmed = value.trim();
  if (trimmed[0] === '"' || trimmed[0] === "'") {
    try {
      return JSON.parse(
        trimmed[0] === "'" ? `"${trimmed.slice(1, -1).replaceAll('"', '\\"')}"` : trimmed,
      );
    } catch {}
  }
  return trimmed;
}

function parseNamedSpecifiers(value: string): { exportedName: string; sourceName: string }[] {
  return splitCommaSeparated(value).flatMap((part) => {
    const match = part.match(/^(.+?)(?:\s+as\s+(.+))?$/);
    if (!match) return [];
    const sourceName = unquoteExportName(match[1]!);
    const exportedName = unquoteExportName(match[2] ?? match[1]!);
    return sourceName && exportedName ? [{ exportedName, sourceName }] : [];
  });
}

type UnresolvedServerReferenceModuleEdges = ServerReferenceModuleEdges & {
  sourceOrder: readonly string[];
};

function collectServerReferenceModuleEdges(
  code: string,
  imports: readonly ScanImport[],
  exports: readonly ScanExport[],
): UnresolvedServerReferenceModuleEdges {
  const sourceOrder: string[] = [];
  const sources = new Set<string>();
  const importsBySource = new Map<string, ServerReferenceModuleEdge>();
  const reexports: ServerReferenceModuleEdge[] = [];
  const importedLocals = new Map<string, ServerReferenceModuleEdge>();

  for (const item of imports) {
    if (!item.n || item.d === -2) continue;
    if (!sources.has(item.n)) {
      sources.add(item.n);
      sourceOrder.push(item.n);
    }
    if (item.d >= 0) {
      importsBySource.set(item.n, { exportNames: "*", sourceId: item.n });
      continue;
    }
    const declaration = code.slice(item.ss, item.se).trim();
    if (declaration.startsWith("export")) {
      const namespace = declaration.match(/^export\s*\*\s+as\s+([^\s]+)\s+from\b/);
      if (namespace) {
        reexports.push({
          exportedName: unquoteExportName(namespace[1]!),
          exportNames: "*",
          sourceId: item.n,
        });
      } else if (/^export\s*\*/.test(declaration)) {
        reexports.push({ exportNames: "*", sourceId: item.n });
      } else {
        const named = declaration.match(/^export\s*\{([\s\S]*?)\}\s*from\b/);
        if (named) {
          for (const specifier of parseNamedSpecifiers(named[1]!)) {
            reexports.push({
              exportedName: specifier.exportedName,
              exportNames: [specifier.sourceName],
              sourceId: item.n,
            });
          }
        }
      }
      continue;
    }
    if (!declaration.startsWith("import")) continue;
    const beforeSource = code.slice(item.ss, item.s);
    const clauseMatch = beforeSource.match(/^\s*import\s+([\s\S]*?)\s+from\s*["']?$/);
    if (!clauseMatch) continue;
    const clause = clauseMatch[1]!.trim();
    const exportNames: string[] = [];
    let consumesNamespace = false;
    const named = clause.match(/\{([\s\S]*?)\}/);
    if (named) {
      for (const specifier of parseNamedSpecifiers(named[1]!)) {
        exportNames.push(specifier.sourceName);
        importedLocals.set(specifier.exportedName, {
          exportNames: [specifier.sourceName],
          sourceId: item.n,
        });
      }
    }
    const namespace = clause.match(/\*\s+as\s+([\w$]+)/);
    if (namespace) {
      consumesNamespace = true;
      importedLocals.set(namespace[1]!, { exportNames: "*", sourceId: item.n });
    }
    const defaultName = clause.match(/^([\w$]+)(?:\s*,|$)/)?.[1];
    if (defaultName) {
      exportNames.push("default");
      importedLocals.set(defaultName, { exportNames: ["default"], sourceId: item.n });
    }
    if (exportNames.length > 0 || consumesNamespace) {
      const existing = importsBySource.get(item.n);
      importsBySource.set(item.n, {
        exportNames:
          consumesNamespace || existing?.exportNames === "*"
            ? "*"
            : [...new Set([...(existing?.exportNames ?? []), ...exportNames])],
        sourceId: item.n,
      });
    }
  }

  for (const item of exports) {
    if (!item.ln) continue;
    const imported = importedLocals.get(item.ln);
    if (imported) reexports.push({ ...imported, exportedName: item.n });
  }

  return {
    imports: sourceOrder.flatMap((source) => {
      const edge = importsBySource.get(source);
      return edge ? [edge] : [];
    }),
    reexports,
    sourceOrder,
  };
}

export function createActionOwnerScanObserver(options?: { environmentName?: string }): {
  moduleEdges: Record<string, ServerReferenceModuleEdges>;
  observe: (event: ActionOwnerScanEvent) => void;
} {
  const environmentName = options?.environmentName ?? "rsc";
  const moduleEdges: Record<string, ServerReferenceModuleEdges> = {};

  return {
    moduleEdges,
    observe(event) {
      if (event.type === "reset") {
        if (event.environmentName !== environmentName) return;
        for (const id of Object.keys(moduleEdges)) delete moduleEdges[id];
        return;
      }
      const pending = collectServerReferenceModuleEdges(event.code, event.imports, event.exports);
      if (pending.imports.length === 0 && pending.reexports.length === 0) return;
      if (event.info.importedIds.length !== pending.sourceOrder.length) {
        return;
      }
      const resolvedIds = new Map(
        pending.sourceOrder.map(
          (source, index) => [source, event.info.importedIds[index]!] as const,
        ),
      );
      const resolveEdges = (edges: readonly ServerReferenceModuleEdge[]) =>
        edges.flatMap((edge) => {
          const sourceId = resolvedIds.get(edge.sourceId);
          return sourceId ? [{ ...edge, sourceId }] : [];
        });
      const imports = resolveEdges(pending.imports);
      const reexports = resolveEdges(pending.reexports);
      if (imports.length > 0 || reexports.length > 0) {
        moduleEdges[event.info.id] = { imports, reexports };
      }
    },
  };
}

function deriveServerReferenceConsumerMap(options: {
  canonicalizeModuleId: (id: string) => string;
  moduleEdges: Readonly<Record<string, ServerReferenceModuleEdges>>;
  serverReferences: readonly ServerReferenceMeta[];
}): Record<string, readonly string[]> {
  const serverReferences = new Map(
    options.serverReferences.map((reference) => [
      options.canonicalizeModuleId(reference.importId),
      reference,
    ]),
  );
  const moduleEdges = new Map(
    Object.entries(options.moduleEdges).map(([id, edges]) => [
      options.canonicalizeModuleId(id),
      {
        imports: edges.imports.map((edge) => ({
          ...edge,
          sourceId: options.canonicalizeModuleId(edge.sourceId),
        })),
        reexports: edges.reexports.map((edge) => ({
          ...edge,
          sourceId: options.canonicalizeModuleId(edge.sourceId),
        })),
      },
    ]),
  );
  const exportedActions = new Map<string, Map<string, readonly string[]>>();
  const resolving = new Set<string>();

  const resolveModuleExports = (id: string): Map<string, readonly string[]> => {
    const cached = exportedActions.get(id);
    if (cached) return cached;
    if (resolving.has(id)) return new Map();
    resolving.add(id);

    const resolved = new Map<string, string[]>();
    const reference = serverReferences.get(id);
    if (reference) {
      for (const exportName of reference.exportNames) {
        resolved.set(exportName, [`${reference.referenceKey}#${exportName}`]);
      }
    }

    for (const edge of moduleEdges.get(id)?.reexports ?? []) {
      const sourceExports = resolveModuleExports(edge.sourceId);
      if (edge.exportNames === "*") {
        if (edge.exportedName) {
          addResolvedActions(resolved, edge.exportedName, [...sourceExports.values()].flat());
        } else {
          for (const [name, actionIds] of sourceExports) {
            if (name !== "default") addResolvedActions(resolved, name, actionIds);
          }
        }
      } else if (edge.exportedName) {
        addResolvedActions(
          resolved,
          edge.exportedName,
          edge.exportNames.flatMap((name) => sourceExports.get(name) ?? []),
        );
      }
    }

    resolving.delete(id);
    exportedActions.set(id, resolved);
    return resolved;
  };

  const consumers: Record<string, readonly string[]> = {};
  for (const [consumerId, edges] of moduleEdges) {
    const actionIds = new Set<string>();
    for (const edge of [...edges.imports, ...edges.reexports]) {
      const sourceExports = resolveModuleExports(edge.sourceId);
      const consumed =
        edge.exportNames === "*"
          ? [...sourceExports.values()].flat()
          : edge.exportNames.flatMap((name) => sourceExports.get(name) ?? []);
      for (const actionId of consumed) actionIds.add(actionId);
    }
    if (actionIds.size > 0) consumers[consumerId] = [...actionIds].sort();
  }
  return consumers;
}

function addResolvedActions(
  target: Map<string, string[]>,
  name: string,
  actionIds: readonly string[],
): void {
  if (actionIds.length > 0) target.set(name, [...(target.get(name) ?? []), ...actionIds]);
}

export function buildActionOwnerManifest(options: {
  canonicalizeModuleId?: (id: string) => string;
  moduleInfo: ModuleInfoProvider;
  routes: readonly ActionOwnerRoute[];
  serverReferenceModuleEdges: Readonly<Record<string, ServerReferenceModuleEdges>>;
  serverReferences: readonly ServerReferenceMeta[];
}): Record<string, string[]> {
  const manifest: Record<string, string[]> = {};
  const canonicalizeModuleId = options.canonicalizeModuleId ?? ((id: string) => id);
  const serverReferenceConsumers = deriveServerReferenceConsumerMap({
    canonicalizeModuleId,
    moduleEdges: options.serverReferenceModuleEdges,
    serverReferences: options.serverReferences,
  });

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
      for (const actionId of serverReferenceConsumers[reachableId] ?? []) {
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
