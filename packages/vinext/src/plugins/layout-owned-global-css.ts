import path from "node:path";
import type { Plugin } from "vite";
import { fnv1a64 } from "../utils/hash.js";

const STYLESHEET_RE = /\.(?:css|less|sass|scss|styl|stylus)$/i;
const CSS_MODULE_RE = /\.module\.(?:css|less|sass|scss|styl|stylus)$/i;
const APP_SHARED_OWNER_RE = /(?:^|\/)(?:layout|template)\.(?:[cm]?[jt]sx?)$/i;
const EMPTY_LAYOUT_CSS_PREFIX = "\0vinext:layout-owned-global-css/";

function cleanModuleId(id: string): string {
  const suffixIndex = id.search(/[?#]/);
  return suffixIndex === -1 ? id : id.slice(0, suffixIndex);
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

export function createLayoutOwnedGlobalCssPlugin(getAppDir: () => string): Plugin {
  const ownerDirectories = new Map<string, Set<string>>();
  const moduleOwners = new Map<string, Set<string>>();
  const moduleImports = new Map<string, Set<string>>();
  const globalStylesheets = new Set<string>();

  function addOwners(moduleId: string, owners: Iterable<string>): void {
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

  function addImport(importer: string, importedId: string): void {
    let imports = moduleImports.get(importer);
    if (!imports) {
      imports = new Set();
      moduleImports.set(importer, imports);
    }
    imports.add(importedId);
  }

  return {
    name: "vinext:layout-owned-global-css",
    enforce: "pre",
    apply: "build",

    async resolveId(source, importer) {
      if (!importer || source.startsWith(EMPTY_LAYOUT_CSS_PREFIX)) return null;

      const sourcePath = cleanModuleId(source);
      const isGlobalStylesheet = STYLESHEET_RE.test(sourcePath) && !CSS_MODULE_RE.test(sourcePath);
      const importerPath = path.resolve(cleanModuleId(importer));
      const normalizedAppDir = path.resolve(getAppDir());

      if (this.environment?.name === "rsc") {
        if (
          isDescendantPath(importerPath, normalizedAppDir) &&
          APP_SHARED_OWNER_RE.test(importerPath)
        ) {
          addOwners(importer, [path.dirname(importerPath)]);
        }

        const resolved = await this.resolve(source, importer, { skipSelf: true });
        if (!resolved || resolved.external || resolved.id.startsWith("\0")) return null;

        const resolvedPath = cleanModuleId(resolved.id);
        if (!path.isAbsolute(resolvedPath)) return null;
        addImport(importer, resolved.id);

        if (isGlobalStylesheet && !hasNonStylesheetQuery(source)) {
          globalStylesheets.add(resolved.id);
        }
        addOwners(resolved.id, moduleOwners.get(importer) ?? []);

        return isGlobalStylesheet && !hasNonStylesheetQuery(source) ? resolved : null;
      }

      if (this.environment?.name !== "client") return null;
      if (!isGlobalStylesheet || hasNonStylesheetQuery(source)) return null;

      const resolved = await this.resolve(source, importer, { skipSelf: true });
      if (!resolved || resolved.external || resolved.id.startsWith("\0")) return null;

      const owners = ownerDirectories.get(resolved.id);
      const importerOwners = moduleOwners.get(importer);
      const isOwnedImport =
        owners &&
        [...owners].some(
          (owner) => isDescendantPath(importerPath, owner) || importerOwners?.has(owner) === true,
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
