import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAppPageChunkGroupPlan,
  generateAppPageChunkGroupModule,
} from "../packages/vinext/src/build/app-page-chunk-groups.js";
import type { AppRoute } from "../packages/vinext/src/routing/app-router.js";

const temporaryDirectories: string[] = [];

function makeRoute(pagePath: string, pattern: string): AppRoute {
  return {
    errorPath: null,
    forbiddenPath: null,
    forbiddenPaths: [],
    isDynamic: false,
    layoutErrorPaths: [],
    layouts: [],
    layoutTreePositions: [],
    loadingPath: null,
    notFoundPath: null,
    notFoundPaths: [],
    pagePath,
    parallelSlots: [],
    params: [],
    pattern,
    patternParts: pattern.split("/").filter(Boolean),
    routePath: null,
    routeSegments: pattern.split("/").filter(Boolean),
    siblingIntercepts: [],
    templates: [],
    unauthorizedPath: null,
    unauthorizedPaths: [],
  };
}

function createFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-page-groups-"));
  temporaryDirectories.push(root);
  return path.join(root, "app");
}

function writePage(appDir: string, routePath: string, size = 100, prefix = ""): string {
  const filePath = path.join(appDir, routePath, "page.tsx");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${prefix}export default function Page() {}\n${"x".repeat(size)}`);
  return filePath;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("App page chunk groups", () => {
  it("groups tiny pages into bounded lazy virtual modules", () => {
    const appDir = createFixture();
    const pagePaths = Array.from({ length: 12 }, (_, index) => writePage(appDir, `route-${index}`));
    const plan = createAppPageChunkGroupPlan(
      appDir,
      pagePaths.map((pagePath, index) => makeRoute(pagePath, `/route-${index}`)),
    );

    expect(plan.groups.length).toBeGreaterThan(0);
    expect(plan.loaders.size).toBe(pagePaths.length);
    for (const group of plan.groups) {
      expect(group.modules.length).toBeGreaterThan(1);
      expect(group.specifier).toMatch(/^virtual:vinext-rsc-page-group\/route-pages-\d+$/);
    }

    const source = generateAppPageChunkGroupModule(plan.groups[0]);
    expect(source).toContain("import * as page_0 from");
    expect(source).toContain("export { page_0");
  });

  it("leaves imported, large, unreadable, and singleton pages as separate imports", () => {
    const appDir = createFixture();
    const smallPage = writePage(appDir, "small");
    const largePage = writePage(appDir, "large", 5_000);
    const importedPage = writePage(
      appDir,
      "imported",
      100,
      'import { Component } from "./component";\n',
    );
    const missingPage = path.join(appDir, "missing", "page.tsx");
    const plan = createAppPageChunkGroupPlan(appDir, [
      makeRoute(smallPage, "/small"),
      makeRoute(largePage, "/large"),
      makeRoute(importedPage, "/imported"),
      makeRoute(missingPage, "/missing"),
    ]);

    expect(plan.groups).toEqual([]);
    expect(plan.loaders.size).toBe(0);
  });
});
