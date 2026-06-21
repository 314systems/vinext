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

function hasLoadingModifier(id: string): boolean {
  return id.includes("?") || id.includes("#");
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
      if (!isDescendantPath(importerPath, normalizedAppDir)) return null;

      if (this.environment?.name === "rsc") {
        if (APP_SHARED_OWNER_RE.test(importerPath)) {
          addOwners(importer, [path.dirname(importerPath)]);
        }

        const resolved = await this.resolve(source, importer, { skipSelf: true });
        if (!resolved || resolved.external || resolved.id.startsWith("\0")) return null;

        const resolvedPath = cleanModuleId(resolved.id);
        if (!isDescendantPath(path.resolve(resolvedPath), normalizedAppDir)) return null;
        addImport(importer, resolved.id);

        if (isGlobalStylesheet && !hasLoadingModifier(source)) {
          globalStylesheets.add(resolved.id);
        }
        addOwners(resolved.id, moduleOwners.get(importer) ?? []);

        return isGlobalStylesheet && !hasLoadingModifier(source) ? resolved : null;
      }

      if (this.environment?.name !== "client") return null;
      if (!isGlobalStylesheet || hasLoadingModifier(source)) return null;

      const resolved = await this.resolve(source, importer, { skipSelf: true });
      if (!resolved || resolved.external || resolved.id.startsWith("\0")) return null;

      const owners = ownerDirectories.get(resolved.id);
      if (!owners || ![...owners].some((owner) => isDescendantPath(importerPath, owner))) {
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
