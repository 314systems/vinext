import fs from "node:fs";
import path from "node:path";
import { parseAst } from "vite";
import type { AppRoute } from "../routing/app-router.js";
import { normalizePathSeparators } from "../utils/path.js";

export const VIRTUAL_RSC_PAGE_GROUP_PREFIX = "virtual:vinext-rsc-page-group/";

const PAGE_GROUP_BUCKETS = 4;
const MAX_GROUP_SIZE = 20_000;
const MAX_PAGE_MODULE_SIZE = 4_096;

export type AppPageChunkLoader = {
  exportName: string;
  specifier: string;
};

export type AppPageChunkGroup = {
  modules: {
    exportName: string;
    filePath: string;
  }[];
  specifier: string;
};

export type AppPageChunkGroupPlan = {
  groups: AppPageChunkGroup[];
  loaders: ReadonlyMap<string, AppPageChunkLoader>;
};

function hashRoutePath(routePath: string): number {
  let hash = 0;
  for (let index = 0; index < routePath.length; index++) {
    hash = (Math.imul(hash, 31) + routePath.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function hasStaticDependencies(source: string, filePath: string): boolean {
  const extension = path.extname(filePath).slice(1);
  const lang =
    extension === "tsx"
      ? "tsx"
      : extension === "jsx"
        ? "jsx"
        : extension === "ts" || extension === "mts" || extension === "cts"
          ? "ts"
          : "js";
  try {
    const program = parseAst(source, { lang });
    return program.body.some(
      (node) =>
        node.type === "ImportDeclaration" ||
        node.type === "ExportAllDeclaration" ||
        (node.type === "ExportNamedDeclaration" && node.source !== null),
    );
  } catch {
    return true;
  }
}

/**
 * Groups tiny production page modules into bounded lazy modules. This keeps
 * route loading lazy while avoiding one sub-kilobyte output chunk per page.
 */
export function createAppPageChunkGroupPlan(
  appDir: string,
  routes: readonly AppRoute[],
): AppPageChunkGroupPlan {
  const pages = new Map<string, { filePath: string; routePath: string; size: number }>();

  for (const route of routes) {
    if (!route.pagePath || pages.has(route.pagePath)) continue;
    try {
      const source = fs.readFileSync(route.pagePath, "utf8");
      const size = Buffer.byteLength(source);
      if (size > MAX_PAGE_MODULE_SIZE || hasStaticDependencies(source, route.pagePath)) continue;
      pages.set(route.pagePath, {
        filePath: route.pagePath,
        routePath: normalizePathSeparators(path.relative(appDir, route.pagePath)),
        size,
      });
    } catch {
      // Unreadable modules retain their ordinary per-route dynamic import.
    }
  }

  const buckets = Array.from(
    { length: PAGE_GROUP_BUCKETS },
    (): { filePath: string; routePath: string; size: number }[] => [],
  );
  for (const page of pages.values()) {
    buckets[hashRoutePath(page.routePath) % PAGE_GROUP_BUCKETS].push(page);
  }

  const groups: AppPageChunkGroup[] = [];
  const loaders = new Map<string, AppPageChunkLoader>();

  for (const bucket of buckets) {
    bucket.sort((left, right) => left.routePath.localeCompare(right.routePath));
    let pending: typeof bucket = [];
    let pendingSize = 0;

    const flush = () => {
      if (pending.length < 2) {
        pending = [];
        pendingSize = 0;
        return;
      }

      const specifier = `${VIRTUAL_RSC_PAGE_GROUP_PREFIX}route-pages-${groups.length}`;
      const modules = pending.map((page, index) => ({
        exportName: `page_${index}`,
        filePath: page.filePath,
      }));
      groups.push({ modules, specifier });
      for (const module of modules) {
        loaders.set(module.filePath, {
          exportName: module.exportName,
          specifier,
        });
      }
      pending = [];
      pendingSize = 0;
    };

    for (const page of bucket) {
      if (pending.length > 0 && pendingSize + page.size > MAX_GROUP_SIZE) flush();
      pending.push(page);
      pendingSize += page.size;
    }
    flush();
  }

  return { groups, loaders };
}

export function generateAppPageChunkGroupModule(group: AppPageChunkGroup): string {
  const imports = group.modules.map(
    (module) =>
      `import * as ${module.exportName} from ${JSON.stringify(normalizePathSeparators(module.filePath))};`,
  );
  const exports = group.modules.map((module) => module.exportName).join(", ");
  return `${imports.join("\n")}\nexport { ${exports} };\n`;
}
