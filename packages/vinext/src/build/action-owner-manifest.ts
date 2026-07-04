import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parseAstAsync, transformWithOxc, type ConfigEnv } from "vite";
import type { AppRoute } from "../routing/app-route-graph.js";

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

type AstNode = {
  type: string;
  [key: string]: unknown;
};

type SourceDependency = {
  names: string[] | null;
  specifier: string;
};

export function actionOwnerManifestMode(
  env: Pick<ConfigEnv, "command" | "isPreview">,
): "development" | "production" {
  return env.command === "serve" && env.isPreview !== true ? "development" : "production";
}

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

function referenceKey(root: string, id: string, mode: "development" | "production"): string {
  const relative = path.relative(root, id).replaceAll(path.sep, "/");
  if (mode === "production") {
    return createHash("sha256").update(relative).digest("hex").slice(0, 12);
  }
  return relative.startsWith("../") ? `/@fs/${id.replaceAll(path.sep, "/")}` : `/${relative}`;
}

function identifierName(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const name = (value as { name?: unknown }).name;
  return typeof name === "string" ? name : null;
}

function literalString(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const literal = value as { type?: unknown; value?: unknown };
  return literal.type === "Literal" && typeof literal.value === "string" ? literal.value : null;
}

function declaredNames(pattern: unknown, names: Set<string>): void {
  if (!pattern || typeof pattern !== "object") return;
  const node = pattern as AstNode;
  if (node.type === "Identifier") {
    const name = identifierName(node);
    if (name) names.add(name);
    return;
  }
  if (node.type === "RestElement") {
    declaredNames(node.argument, names);
    return;
  }
  if (node.type === "AssignmentPattern") {
    declaredNames(node.left, names);
    return;
  }
  if (node.type === "ArrayPattern") {
    for (const element of (node.elements as unknown[] | undefined) ?? []) {
      declaredNames(element, names);
    }
    return;
  }
  if (node.type === "ObjectPattern") {
    for (const property of (node.properties as AstNode[] | undefined) ?? []) {
      declaredNames(property.type === "Property" ? property.value : property.argument, names);
    }
  }
}

function exportedNames(program: AstNode): string[] {
  const names = new Set<string>();
  for (const statement of (program.body as AstNode[] | undefined) ?? []) {
    if (statement.type === "ExportDefaultDeclaration") {
      names.add("default");
      continue;
    }
    if (statement.type !== "ExportNamedDeclaration") continue;
    const declaration = statement.declaration as AstNode | null | undefined;
    if (declaration?.type === "VariableDeclaration") {
      for (const declarator of (declaration.declarations as AstNode[] | undefined) ?? []) {
        declaredNames(declarator.id, names);
      }
    } else if (declaration) {
      const name = identifierName(declaration.id);
      if (name) names.add(name);
    }
    for (const specifier of (statement.specifiers as AstNode[] | undefined) ?? []) {
      const name = identifierName(specifier.exported);
      if (name) names.add(name);
    }
  }
  return [...names];
}

function hasModuleUseServerDirective(program: AstNode): boolean {
  for (const statement of (program.body as AstNode[] | undefined) ?? []) {
    if (statement.type !== "ExpressionStatement") return false;
    const directive = statement.directive;
    if (directive === "use server") return true;
    if (typeof directive !== "string") return false;
  }
  return false;
}

function importedNames(specifiers: readonly AstNode[]): string[] | null {
  const names = new Set<string>();
  for (const specifier of specifiers) {
    if (specifier.type === "ImportNamespaceSpecifier") return null;
    if (specifier.type === "ImportDefaultSpecifier") names.add("default");
    if (specifier.type === "ImportSpecifier") {
      const name = identifierName(specifier.imported);
      if (name) names.add(name);
    }
  }
  return [...names];
}

function reexportedNames(
  specifiers: readonly AstNode[],
  requestedNames: string[] | null,
): string[] {
  const requested = requestedNames ? new Set(requestedNames) : null;
  const names = new Set<string>();
  for (const specifier of specifiers) {
    const exportedName = identifierName(specifier.exported);
    const sourceName = identifierName(specifier.local);
    if (sourceName && (!requested || (exportedName && requested.has(exportedName)))) {
      names.add(sourceName);
    }
  }
  return [...names];
}

function collectImportExpressions(node: unknown, dependencies: SourceDependency[]): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const value of node) collectImportExpressions(value, dependencies);
    return;
  }
  const astNode = node as AstNode;
  if (astNode.type === "ImportExpression") {
    const specifier = literalString(astNode.source);
    if (specifier) dependencies.push({ names: null, specifier });
    return;
  }
  for (const [key, value] of Object.entries(astNode)) {
    if (key === "start" || key === "end" || key === "loc") continue;
    collectImportExpressions(value, dependencies);
  }
}

function sourceDependencies(
  program: AstNode,
  requestedNames: string[] | null,
  includeImports: boolean,
): SourceDependency[] {
  const dependencies: SourceDependency[] = [];
  for (const statement of (program.body as AstNode[] | undefined) ?? []) {
    if (includeImports && statement.type === "ImportDeclaration") {
      const specifier = literalString(statement.source);
      if (specifier) {
        dependencies.push({
          names: importedNames((statement.specifiers as AstNode[] | undefined) ?? []),
          specifier,
        });
      }
      continue;
    }
    if (statement.type === "ExportNamedDeclaration" && statement.source) {
      const specifier = literalString(statement.source);
      if (specifier) {
        dependencies.push({
          names: reexportedNames(
            (statement.specifiers as AstNode[] | undefined) ?? [],
            requestedNames,
          ),
          specifier,
        });
      }
      continue;
    }
    if (statement.type === "ExportAllDeclaration") {
      const specifier = literalString(statement.source);
      if (specifier) {
        const namespaceName = identifierName(statement.exported);
        const names = namespaceName
          ? requestedNames === null || requestedNames.includes(namespaceName)
            ? null
            : []
          : requestedNames;
        dependencies.push({ names, specifier });
      }
      continue;
    }
    if (includeImports) collectImportExpressions(statement, dependencies);
  }
  return dependencies;
}

function addOwner(manifest: Record<string, string[]>, key: string, pattern: string): void {
  const owners = (manifest[key] ??= []);
  if (!owners.includes(pattern)) owners.push(pattern);
}

export function buildActionOwnerManifest(options: {
  canonicalizeModuleId?: (id: string) => string;
  moduleInfo: ModuleInfoProvider;
  routes: readonly ActionOwnerRoute[];
  serverReferences: readonly ServerReferenceMeta[];
  staticOwners: Readonly<Record<string, readonly string[]>>;
}): Record<string, string[]> {
  const manifest: Record<string, string[]> = {};
  const canonicalizeModuleId = options.canonicalizeModuleId ?? ((id: string) => id);

  for (const route of options.routes) {
    const entryIds = actionOwnerRouteEntryIds(route);
    const routeComponentIds = new Set(entryIds.map(canonicalizeModuleId));
    const reachableIds = new Set(routeComponentIds);
    const queue = [...routeComponentIds];
    for (let index = 0; index < queue.length; index++) {
      const moduleInfo = options.moduleInfo.getModuleInfo(queue[index]!);
      for (const importedId of [
        ...(moduleInfo?.importedIds ?? []),
        ...(moduleInfo?.dynamicImportedIds ?? []),
      ]) {
        const canonicalImportedId = canonicalizeModuleId(importedId);
        if (reachableIds.has(canonicalImportedId)) continue;
        reachableIds.add(canonicalImportedId);
        queue.push(canonicalImportedId);
      }
    }

    for (const reference of options.serverReferences) {
      const referenceId = canonicalizeModuleId(reference.importId);
      if (!reachableIds.has(referenceId)) continue;
      if (routeComponentIds.has(referenceId)) {
        addOwner(manifest, reference.referenceKey, route.pattern);
      }
      for (const exportName of reference.exportNames) {
        const actionId = `${reference.referenceKey}#${exportName}`;
        if (
          routeComponentIds.has(referenceId) ||
          options.staticOwners[actionId]?.includes(route.pattern)
        ) {
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
    () => `function ${match[1]}() { return ${JSON.stringify(manifest)}; }`,
  );
}

export async function buildStaticActionOwnerManifest(options: {
  mode: "development" | "production";
  root: string;
  routes: readonly ActionOwnerRoute[];
  resolve: (source: string, importer?: string) => Promise<{ id: string } | null>;
}): Promise<Record<string, string[]>> {
  const manifest: Record<string, string[]> = {};
  const modulePrograms = new Map<string, Promise<AstNode | null>>();
  const resolvedDependencies = new Map<string, Promise<{ id: string } | null>>();

  function loadProgram(id: string): Promise<AstNode | null> {
    let pending = modulePrograms.get(id);
    if (pending) return pending;
    pending = (async () => {
      let source: string;
      try {
        source = await fs.readFile(id, "utf8");
      } catch {
        return null;
      }

      const extension = path.extname(id).toLowerCase();
      try {
        source = (
          await transformWithOxc(source, id, {
            lang: extension === ".ts" ? "ts" : extension === ".tsx" ? "tsx" : "jsx",
            jsx: { runtime: "automatic" },
            sourcemap: false,
          })
        ).code;
        return (await parseAstAsync(source)) as unknown as AstNode;
      } catch {
        return null;
      }
    })();
    modulePrograms.set(id, pending);
    return pending;
  }

  function resolveDependency(specifier: string, importer: string): Promise<{ id: string } | null> {
    const key = `${importer}\0${specifier}`;
    let pending = resolvedDependencies.get(key);
    if (pending) return pending;
    pending = options.resolve(specifier, importer).catch(() => null);
    resolvedDependencies.set(key, pending);
    return pending;
  }

  for (const route of options.routes) {
    const entryIds = actionOwnerRouteEntryIds(route);
    const entrySet = new Set(entryIds);
    const queue = entryIds.map((id) => ({ id, names: null as string[] | null }));
    const visited = new Set<string>();

    for (let index = 0; index < queue.length; index++) {
      const current = queue[index]!;
      const visitKey = `${current.id}\0${current.names?.join(",") ?? "*"}`;
      if (visited.has(visitKey)) continue;
      visited.add(visitKey);

      const program = await loadProgram(current.id);
      if (!program) continue;

      const moduleReferenceKey = referenceKey(options.root, current.id, options.mode);
      if (entrySet.has(current.id)) addOwner(manifest, moduleReferenceKey, route.pattern);

      if (hasModuleUseServerDirective(program)) {
        for (const name of current.names ?? exportedNames(program)) {
          addOwner(manifest, `${moduleReferenceKey}#${name}`, route.pattern);
        }
        continue;
      }

      const includeImports = !current.id.includes(`${path.sep}node_modules${path.sep}`);
      for (const dependency of sourceDependencies(program, current.names, includeImports)) {
        if (dependency.names?.length === 0) continue;
        const resolved = await resolveDependency(dependency.specifier, current.id);
        if (!resolved || resolved.id.includes("?")) continue;
        queue.push({ id: resolved.id, names: dependency.names });
      }
    }
  }

  return manifest;
}
