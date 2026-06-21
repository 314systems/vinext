import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { resolveAppRouteBuildRuntime } from "../packages/vinext/src/build/app-route-runtime.js";
import type { AppRoute } from "../packages/vinext/src/routing/app-router.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function createRouteFiles(files: Record<string, string>): Promise<{
  root: string;
  paths: Record<string, string>;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-app-route-runtime-"));
  roots.push(root);
  const paths: Record<string, string> = {};
  for (const [name, source] of Object.entries(files)) {
    const filePath = path.join(root, name);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, source);
    paths[name] = filePath;
  }
  return { root, paths };
}

function route(overrides: Partial<AppRoute>): AppRoute {
  return {
    pattern: "/",
    pagePath: null,
    routePath: null,
    layouts: [],
    templates: [],
    parallelSlots: [],
    siblingIntercepts: [],
    loadingPath: null,
    errorPath: null,
    layoutErrorPaths: [],
    notFoundPath: null,
    notFoundPaths: [],
    forbiddenPaths: [],
    forbiddenPath: null,
    unauthorizedPath: null,
    unauthorizedPaths: [],
    routeSegments: [],
    layoutTreePositions: [],
    rootParamNames: [],
    isDynamic: false,
    params: [],
    patternParts: [],
    ...overrides,
  };
}

describe("App route build runtime", () => {
  it("extracts static runtime exports without matching comments or strings", async () => {
    const { paths } = await createRouteFiles({
      "layout.tsx": `
        // export const runtime = "edge"
        const example = 'export const runtime = "edge"'
        export default function Layout({ children }) { return children }
      `,
      "page.tsx": `
        export const runtime = \`edge\` satisfies "edge" | "nodejs"
        export default function Page() { return null }
      `,
    });

    expect(
      resolveAppRouteBuildRuntime(
        route({ layouts: [paths["layout.tsx"]], pagePath: paths["page.tsx"] }),
      ),
    ).toBe("edge");
  });

  it("does not inherit layout runtime for route handlers", async () => {
    const { paths } = await createRouteFiles({
      "layout.tsx": `export const runtime = "edge"`,
      "route.ts": `export function GET() { return new Response("ok") }`,
    });

    expect(
      resolveAppRouteBuildRuntime(
        route({ layouts: [paths["layout.tsx"]], routePath: paths["route.ts"] }),
      ),
    ).toBe("nodejs");
  });
});
