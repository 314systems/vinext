import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appRoutesNeedResponseCache } from "../packages/vinext/src/build/app-response-cache-capabilities.js";
import type { AppRoute } from "../packages/vinext/src/routing/app-router.js";

const temporaryDirectories: string[] = [];

function writeRouteFile(relativePath: string, source: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-response-cache-"));
  temporaryDirectories.push(root);
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, source);
  return filePath;
}

function makeRoute(overrides: Partial<AppRoute>): AppRoute {
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
    pagePath: null,
    parallelSlots: [],
    params: [],
    pattern: "/",
    patternParts: [],
    routePath: null,
    routeSegments: [],
    siblingIntercepts: [],
    templates: [],
    unauthorizedPath: null,
    unauthorizedPaths: [],
    ...overrides,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("appRoutesNeedResponseCache", () => {
  it("omits response ISR when a shared layout forces every page dynamic", () => {
    const layoutPath = writeRouteFile("app/layout.tsx", 'export const dynamic = "force-dynamic";');
    const pagePath = writeRouteFile("app/page.tsx", "export default function Page() {}");

    expect(appRoutesNeedResponseCache([makeRoute({ layouts: [layoutPath], pagePath })])).toBe(
      false,
    );
  });

  it("retains response ISR for pages without a provably dynamic segment", () => {
    const layoutPath = writeRouteFile("app/layout.tsx", "export default function Layout() {}");
    const pagePath = writeRouteFile("app/page.tsx", "export default function Page() {}");

    expect(appRoutesNeedResponseCache([makeRoute({ layouts: [layoutPath], pagePath })])).toBe(true);
  });

  it("retains response ISR for route handlers with a positive revalidate", () => {
    const routePath = writeRouteFile("app/api/route.ts", "export const revalidate = 60;");

    expect(appRoutesNeedResponseCache([makeRoute({ routePath })])).toBe(true);
  });

  it("omits response ISR for uncached and force-dynamic route handlers", () => {
    const uncachedRoutePath = writeRouteFile("app/api/plain/route.ts", "export function GET() {}");
    const dynamicRoutePath = writeRouteFile(
      "app/api/dynamic/route.ts",
      'export const dynamic = "force-dynamic"; export const revalidate = 60;',
    );

    expect(
      appRoutesNeedResponseCache([
        makeRoute({ routePath: uncachedRoutePath }),
        makeRoute({ pattern: "/dynamic", routePath: dynamicRoutePath }),
      ]),
    ).toBe(false);
  });

  it("retains response ISR when route source cannot be inspected", () => {
    expect(
      appRoutesNeedResponseCache([
        makeRoute({ pagePath: "/missing/app/page.tsx", layouts: ["/missing/app/layout.tsx"] }),
      ]),
    ).toBe(true);
  });
});
