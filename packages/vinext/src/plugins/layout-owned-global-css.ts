import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { parseSync, type ESTree, type Plugin } from "vite";
import { fnv1a64 } from "../utils/hash.js";

const STYLESHEET_RE = /\.(?:css|less|sass|scss|styl|stylus)$/i;
const CSS_MODULE_RE = /\.module\.(?:css|less|sass|scss|styl|stylus)$/i;
const APP_SHARED_OWNER_RE = /(?:^|\/)(?:layout|template)\.(?:[cm]?[jt]sx?)$/i;
const EMPTY_LAYOUT_CSS_PREFIX = "\0vinext:layout-owned-global-css/";
const SOURCE_MODULE_RE = /\.(?:[cm]?[jt]sx?)$/i;
const MAX_EXTERNAL_GRAPH_MODULES_PER_ROOT = 10_000;

type ResolveContext = {
  resolve(
    source: string,
    importer?: string,
    options?: { skipSelf?: boolean },
  ): Promise<{ id: string } | null>;
};

function cleanModuleId(id: string): string {
  const suffixIndex = id.search(/[?#]/);
  return suffixIndex === -1 ? id : id.slice(0, suffixIndex);
}

function graphModuleId(id: string): string {
  return STYLESHEET_RE.test(cleanModuleId(id)) ? id : cleanModuleId(id);
}

function hasNonStylesheetQuery(id: string): boolean {
  const queryIndex = id.indexOf("?");
  if (queryIndex === -1) return false;

  const hashIndex = id.indexOf("#", queryIndex);
  const query = id.slice(queryIndex + 1, hashIndex === -1 ? undefined : hashIndex);
  const params = new URLSearchParams(query);
  return params.has("inline") || params.has("raw") || params.has("url");
}

function isDescendantPath(filePath: string, directory: string): boolean {
  const relative = path.relative(directory, filePath);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function sourceModuleLang(modulePath: string): "js" | "jsx" | "ts" | "tsx" {
  if (/\.(?:mts|cts|ts)$/i.test(modulePath)) return "ts";
  if (/\.tsx$/i.test(modulePath)) return "tsx";
  if (/\.jsx$/i.test(modulePath)) return "jsx";
  return "js";
}

function extractModuleSources(
  modulePath: string,
  source: string,
): Array<{ source: string; isDynamic: boolean }> {
  const result = parseSync(modulePath, source, {
    astType: "ts",
    lang: sourceModuleLang(modulePath),
    sourceType: "module",
  });
  const parseError = result.errors.find((error) => error.severity === "Error");
  if (parseError) {
    throw new Error(
      `Unable to scan layout-owned CSS imports in ${modulePath}: ${parseError.message}`,
    );
  }

  const sources = new Map<string, boolean>();

  function visit(node: ESTree.Node | ESTree.Node[] | null | undefined): void {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }

    if (
      node.type === "ImportDeclaration" ||
      node.type === "ExportNamedDeclaration" ||
      node.type === "ExportAllDeclaration"
    ) {
      if (node.source && typeof node.source.value === "string") {
        sources.set(node.source.value, false);
      }
    } else if (
      node.type === "ImportExpression" &&
      node.source.type === "Literal" &&
      typeof node.source.value === "string"
    ) {
      if (!sources.has(node.source.value)) sources.set(node.source.value, true);
    }

    for (const [key, value] of Object.entries(node)) {
      if (key === "type" || key === "start" || key === "end" || key === "loc" || key === "parent") {
        continue;
      }
      if (value && typeof value === "object") {
        visit(value as ESTree.Node | ESTree.Node[]);
      }
    }
  }

  visit(result.program);
  return [...sources].map(([source, isDynamic]) => ({ source, isDynamic }));
}

export function createLayoutOwnedGlobalCssPlugin(
  getAppDir: () => string,
  getPagesDir: () => string | null = () => null,
): Plugin {
  const ownerDirectories = new Map<string, Set<string>>();
  const moduleOwners = new Map<string, Set<string>>();
  const moduleImports = new Map<string, Set<string>>();
  const moduleImporters = new Map<string, Set<string>>();
  const globalStylesheets = new Set<string>();
  const pagesConsumers = new Set<string>();
  const pagesImports = new Map<string, Set<string>>();

  function addOwners(moduleId: string, owners: Iterable<string>): void {
    moduleId = graphModuleId(moduleId);
    let moduleOwnerDirectories = moduleOwners.get(moduleId);
    if (!moduleOwnerDirectories) {
      moduleOwnerDirectories = new Set();
      moduleOwners.set(moduleId, moduleOwnerDirectories);
    }
    const addedOwners: string[] = [];
    for (const owner of owners) {
      if (moduleOwnerDirectories.has(owner)) continue;
      moduleOwnerDirectories.add(owner);
      addedOwners.push(owner);
    }
    if (addedOwners.length === 0) return;

    if (globalStylesheets.has(moduleId)) {
      let stylesheetOwners = ownerDirectories.get(moduleId);
      if (!stylesheetOwners) {
        stylesheetOwners = new Set();
        ownerDirectories.set(moduleId, stylesheetOwners);
      }
      for (const owner of addedOwners) stylesheetOwners.add(owner);
    }

    for (const importedId of moduleImports.get(moduleId) ?? []) {
      addOwners(importedId, addedOwners);
    }
  }

  function addImport(importer: string, importedId: string, propagateOwners = true): void {
    importer = graphModuleId(importer);
    importedId = graphModuleId(importedId);
    let imports = moduleImports.get(importer);
    if (!imports) {
      imports = new Set();
      moduleImports.set(importer, imports);
    }
    if (propagateOwners) imports.add(importedId);

    let importers = moduleImporters.get(importedId);
    if (!importers) {
      importers = new Set();
      moduleImporters.set(importedId, importers);
    }
    importers.add(importer);
  }

  function markPagesConsumer(moduleId: string): void {
    moduleId = graphModuleId(moduleId);
    if (pagesConsumers.has(moduleId)) return;
    pagesConsumers.add(moduleId);
    for (const importedId of pagesImports.get(moduleId) ?? []) {
      markPagesConsumer(importedId);
    }
  }

  function addPagesImport(importer: string, importedId: string): void {
    importer = graphModuleId(importer);
    importedId = graphModuleId(importedId);
    let imports = pagesImports.get(importer);
    if (!imports) {
      imports = new Set();
      pagesImports.set(importer, imports);
    }
    imports.add(importedId);
    addImport(importer, importedId, false);
    if (pagesConsumers.has(importer)) markPagesConsumer(importedId);
  }

  function allConsumersInheritOwner(moduleId: string, owner: string, appDir: string): boolean {
    const visited = new Set<string>();

    function visit(currentId: string): boolean {
      currentId = graphModuleId(currentId);
      if (visited.has(currentId)) return true;
      visited.add(currentId);

      if (pagesConsumers.has(currentId)) return false;

      const currentPath = path.resolve(cleanModuleId(currentId));
      if (APP_SHARED_OWNER_RE.test(currentPath) && path.dirname(currentPath) === owner) return true;

      const importers = moduleImporters.get(currentId);
      if (importers && importers.size > 0) {
        return [...importers].every(visit);
      }

      if (moduleOwners.get(currentId)?.has(owner) === true) return true;
      if (!isDescendantPath(currentPath, appDir)) return false;
      return isDescendantPath(currentPath, owner);
    }

    return visit(moduleId);
  }

  async function resolveExternalImport(
    context: ResolveContext,
    source: string,
    importer: string,
  ): Promise<string | null> {
    const resolved = await context.resolve(source, cleanModuleId(importer), { skipSelf: true });
    if (resolved && !resolved.id.startsWith("\0") && path.isAbsolute(cleanModuleId(resolved.id))) {
      return resolved.id;
    }

    if (source.startsWith(".")) {
      const relativePath = path.resolve(
        path.dirname(cleanModuleId(importer)),
        cleanModuleId(source),
      );
      try {
        if ((await fs.stat(relativePath)).isFile()) return relativePath;
      } catch {}
    }

    try {
      return createRequire(cleanModuleId(importer)).resolve(source);
    } catch {
      return null;
    }
  }

  async function scanExternalModule(context: ResolveContext, rootModuleId: string): Promise<void> {
    const rootPath = cleanModuleId(rootModuleId);
    if (!SOURCE_MODULE_RE.test(rootPath)) return;

    const visited = new Set<string>();
    const pending = [rootModuleId];
    const edges: Array<{
      importer: string;
      imported: string;
      globalStylesheet: boolean;
      isDynamic: boolean;
    }> = [];

    while (pending.length > 0) {
      const moduleId = pending.pop()!;
      const modulePath = cleanModuleId(moduleId);
      if (visited.has(modulePath) || !SOURCE_MODULE_RE.test(modulePath)) continue;
      visited.add(modulePath);
      if (visited.size > MAX_EXTERNAL_GRAPH_MODULES_PER_ROOT) {
        throw new Error(
          `Layout-owned CSS dependency graph from ${rootPath} exceeds ${MAX_EXTERNAL_GRAPH_MODULES_PER_ROOT.toLocaleString()} modules`,
        );
      }

      let source: string;
      try {
        source = await fs.readFile(modulePath, "utf8");
      } catch {
        continue;
      }

      for (const { source: importSource, isDynamic } of extractModuleSources(modulePath, source)) {
        const importedPath = await resolveExternalImport(context, importSource, modulePath);
        if (!importedPath) continue;
        const globalStylesheet =
          STYLESHEET_RE.test(cleanModuleId(importedPath)) &&
          !CSS_MODULE_RE.test(cleanModuleId(importedPath)) &&
          !hasNonStylesheetQuery(importSource);
        edges.push({
          importer: moduleId,
          imported: importedPath,
          globalStylesheet: globalStylesheet && !isDynamic,
          isDynamic,
        });
        if (!globalStylesheet && !isDynamic) pending.push(importedPath);
      }
    }

    for (const edge of edges) {
      addImport(edge.importer, edge.imported, !edge.isDynamic);
      if (edge.globalStylesheet) globalStylesheets.add(edge.imported);
      if (!edge.isDynamic) {
        addOwners(edge.imported, moduleOwners.get(graphModuleId(edge.importer)) ?? []);
      }
    }
  }

  return {
    name: "vinext:layout-owned-global-css",
    enforce: "pre",
    apply: "build",

    async resolveDynamicImport(source, importer) {
      if (typeof source !== "string" || !importer) return null;
      const resolved = await this.resolve(source, importer, { skipSelf: true });
      if (!resolved || resolved.id.startsWith("\0")) return null;
      if (this.environment?.name === "rsc") {
        addImport(importer, resolved.id, false);
      } else if (this.environment?.name === "ssr") {
        const pagesDir = getPagesDir();
        if (!pagesDir) return resolved;
        const normalizedPagesDir = path.resolve(pagesDir);
        const importerId = graphModuleId(importer);
        if (isDescendantPath(path.resolve(cleanModuleId(importer)), normalizedPagesDir)) {
          markPagesConsumer(importer);
        }
        if (pagesConsumers.has(importerId)) addPagesImport(importer, resolved.id);
      }
      return resolved;
    },

    async resolveId(source, importer) {
      if (!importer || source.startsWith(EMPTY_LAYOUT_CSS_PREFIX)) return null;

      const sourcePath = cleanModuleId(source);
      const isGlobalStylesheet = STYLESHEET_RE.test(sourcePath) && !CSS_MODULE_RE.test(sourcePath);
      const importerPath = path.resolve(cleanModuleId(importer));
      const normalizedAppDir = path.resolve(getAppDir());
      const pagesDir = getPagesDir();
      const normalizedPagesDir = pagesDir ? path.resolve(pagesDir) : null;

      if (this.environment?.name === "ssr" && normalizedPagesDir) {
        const importerId = graphModuleId(importer);
        const isPagesRoute = isDescendantPath(importerPath, normalizedPagesDir);
        if (!isPagesRoute && !pagesConsumers.has(importerId)) return null;
        const resolved = await this.resolve(source, importer, { skipSelf: true });
        if (!resolved || resolved.id.startsWith("\0")) return null;
        if (isPagesRoute) markPagesConsumer(importer);
        addPagesImport(importer, resolved.id);
        return null;
      }

      if (this.environment?.name === "rsc") {
        if (
          isDescendantPath(importerPath, normalizedAppDir) &&
          APP_SHARED_OWNER_RE.test(importerPath)
        ) {
          addOwners(importer, [path.dirname(importerPath)]);
        }

        const resolved = await this.resolve(source, importer, { skipSelf: true });
        if (!resolved || resolved.id.startsWith("\0")) return null;

        const resolvedPath = cleanModuleId(resolved.id);
        if (!path.isAbsolute(resolvedPath)) return null;
        addImport(importer, resolved.id);

        if (isGlobalStylesheet && !hasNonStylesheetQuery(source)) {
          globalStylesheets.add(resolved.id);
        }
        addOwners(resolved.id, moduleOwners.get(graphModuleId(importer)) ?? []);
        if (resolved.external) await scanExternalModule(this, resolved.id);

        return isGlobalStylesheet && !hasNonStylesheetQuery(source) ? resolved : null;
      }

      if (this.environment?.name !== "client") return null;
      if (!isGlobalStylesheet || hasNonStylesheetQuery(source)) return null;

      const resolved = await this.resolve(source, importer, { skipSelf: true });
      if (!resolved || resolved.external || resolved.id.startsWith("\0")) return null;

      const owners = ownerDirectories.get(resolved.id);
      const importerOwners = moduleOwners.get(graphModuleId(importer));
      const isOwnedImport =
        owners &&
        [...owners].some(
          (owner) =>
            (isDescendantPath(importerPath, owner) || importerOwners?.has(owner) === true) &&
            allConsumersInheritOwner(importer, owner, normalizedAppDir),
        );
      if (!isOwnedImport) {
        return null;
      }

      return `${EMPTY_LAYOUT_CSS_PREFIX}${fnv1a64(resolved.id)}.css`;
    },

    load(id) {
      if (id.startsWith(EMPTY_LAYOUT_CSS_PREFIX)) return "";
      return null;
    },
  };
}
