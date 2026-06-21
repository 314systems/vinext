import path from "node:path";
import type { Plugin } from "vite";
import { fnv1a64 } from "../utils/hash.js";

const STYLESHEET_RE = /\.(?:css|less|sass|scss|styl|stylus)$/i;
const CSS_MODULE_RE = /\.module\.(?:css|less|sass|scss|styl|stylus)$/i;
const APP_LAYOUT_RE = /(?:^|\/)layout\.(?:[cm]?[jt]sx?)$/i;
const EMPTY_LAYOUT_CSS_PREFIX = "\0vinext:layout-owned-global-css/";

function cleanModuleId(id: string): string {
  const queryIndex = id.indexOf("?");
  return queryIndex === -1 ? id : id.slice(0, queryIndex);
}

function isDescendantPath(filePath: string, directory: string): boolean {
  const relative = path.relative(directory, filePath);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

export function createLayoutOwnedGlobalCssPlugin(getAppDir: () => string): Plugin {
  const ownerDirectories = new Map<string, Set<string>>();

  return {
    name: "vinext:layout-owned-global-css",
    enforce: "pre",
    apply: "build",

    async resolveId(source, importer) {
      if (!importer || source.startsWith(EMPTY_LAYOUT_CSS_PREFIX)) return null;

      const sourcePath = cleanModuleId(source);
      if (!STYLESHEET_RE.test(sourcePath) || CSS_MODULE_RE.test(sourcePath)) return null;

      const resolved = await this.resolve(source, importer, { skipSelf: true });
      if (!resolved || resolved.external || resolved.id.startsWith("\0")) return null;

      const stylesheetPath = path.resolve(cleanModuleId(resolved.id));
      const importerPath = path.resolve(cleanModuleId(importer));
      const normalizedAppDir = path.resolve(getAppDir());
      if (!isDescendantPath(importerPath, normalizedAppDir)) return null;

      if (this.environment?.name === "rsc" && APP_LAYOUT_RE.test(importerPath)) {
        let owners = ownerDirectories.get(stylesheetPath);
        if (!owners) {
          owners = new Set();
          ownerDirectories.set(stylesheetPath, owners);
        }
        owners.add(path.dirname(importerPath));
        return resolved;
      }

      if (this.environment?.name !== "client") return null;
      const owners = ownerDirectories.get(stylesheetPath);
      if (!owners || ![...owners].some((owner) => isDescendantPath(importerPath, owner))) {
        return null;
      }

      return `${EMPTY_LAYOUT_CSS_PREFIX}${fnv1a64(stylesheetPath)}.css`;
    },

    load(id) {
      if (id.startsWith(EMPTY_LAYOUT_CSS_PREFIX)) return "";
      return null;
    },
  };
}
