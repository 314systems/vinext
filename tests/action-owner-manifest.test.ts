import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { AppRoute } from "../packages/vinext/src/routing/app-route-graph.js";
import {
  actionOwnerManifestMode,
  actionOwnerRouteEntryIds,
  buildActionOwnerManifest,
  buildStaticActionOwnerManifest,
} from "../packages/vinext/src/build/action-owner-manifest.js";

let roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

function route(pattern: string, pagePath: string) {
  return {
    errorPath: null,
    errorPaths: [],
    forbiddenPath: null,
    forbiddenPaths: [],
    layoutErrorPaths: [],
    layouts: [],
    loadingPath: null,
    notFoundPath: null,
    notFoundPaths: [],
    pagePath,
    parallelSlots: [],
    pattern,
    templates: [],
    unauthorizedPath: null,
    unauthorizedPaths: [],
    siblingIntercepts: [],
  };
}

async function fixture(files: Record<string, string>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-action-owner-"));
  roots.push(root);
  for (const [relativePath, source] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, source);
  }
  return {
    root,
    resolve: async (specifier: string, importer?: string) => {
      const candidate = path.resolve(importer ? path.dirname(importer) : root, specifier);
      for (const filePath of [candidate, `${candidate}.ts`, `${candidate}.tsx`]) {
        try {
          if ((await fs.stat(filePath)).isFile()) return { id: filePath };
        } catch {}
      }
      return null;
    },
  };
}

function productionKey(relativePath: string): string {
  return createHash("sha256").update(relativePath).digest("hex").slice(0, 12);
}

describe("server action owner manifest", () => {
  it("treats Vite preview as production despite command serve", () => {
    expect(actionOwnerManifestMode({ command: "serve", isPreview: false })).toBe("development");
    expect(actionOwnerManifestMode({ command: "serve", isPreview: true })).toBe("production");
    expect(actionOwnerManifestMode({ command: "build" })).toBe("production");
  });
  it("maps only imported action exports to each owning route", async () => {
    const app = await fixture({
      "app/actions.ts": `'use server';\nexport async function publicOnly() {}\nexport async function adminOnly() {}\n`,
      "app/admin/page.tsx": `import { adminOnly } from "../actions"; export default function Page() { return adminOnly; }`,
      "app/page.tsx": `import { publicOnly } from "./actions"; export default function Page() { return publicOnly; }`,
    });

    const manifest = await buildStaticActionOwnerManifest({
      mode: "production",
      root: app.root,
      routes: [
        route("/", path.join(app.root, "app/page.tsx")),
        route("/admin", path.join(app.root, "app/admin/page.tsx")),
      ],
      resolve: app.resolve,
    });

    const actionKey = productionKey("app/actions.ts");
    expect(manifest[`${actionKey}#publicOnly`]).toEqual(["/"]);
    expect(manifest[`${actionKey}#adminOnly`]).toEqual(["/admin"]);
  });

  it("uses the unchanged plugin-rsc production and development reference keys", async () => {
    const app = await fixture({
      "app/actions.ts": `'use server'; export default async function action() {}`,
      "app/page.tsx": `import action from "./actions"; export default function Page() { return action; }`,
    });
    const pagePath = path.join(app.root, "app/page.tsx");

    const production = await buildStaticActionOwnerManifest({
      mode: "production",
      root: app.root,
      routes: [route("/", pagePath)],
      resolve: app.resolve,
    });
    const development = await buildStaticActionOwnerManifest({
      mode: "development",
      root: app.root,
      routes: [route("/", pagePath)],
      resolve: app.resolve,
    });

    expect(production[`${productionKey("app/actions.ts")}#default`]).toEqual(["/"]);
    expect(development["/app/actions.ts#default"]).toEqual(["/"]);
  });

  it("traces aliased re-exports to the original server action export", async () => {
    const app = await fixture({
      "app/actions.ts": `'use server'; export async function original() {}`,
      "app/barrel.ts": `export { original as exposed } from "./actions";`,
      "app/page.tsx": `import { exposed } from "./barrel"; export default function Page() { return exposed; }`,
    });

    const manifest = await buildStaticActionOwnerManifest({
      mode: "production",
      root: app.root,
      routes: [route("/", path.join(app.root, "app/page.tsx"))],
      resolve: app.resolve,
    });

    expect(manifest[`${productionKey("app/actions.ts")}#original`]).toEqual(["/"]);
  });

  it("does not authorize sibling exports from a shared barrel", async () => {
    const app = await fixture({
      "app/actions.ts": `'use server'; export async function publicOnly() {} export async function adminOnly() {}`,
      "app/barrel.ts": `export { publicOnly, adminOnly } from "./actions";`,
      "app/page.tsx": `import { publicOnly } from "./barrel"; export default function Page() { return publicOnly; }`,
    });

    const manifest = await buildStaticActionOwnerManifest({
      mode: "production",
      root: app.root,
      routes: [route("/", path.join(app.root, "app/page.tsx"))],
      resolve: app.resolve,
    });

    const actionKey = productionKey("app/actions.ts");
    expect(manifest[`${actionKey}#publicOnly`]).toEqual(["/"]);
    expect(manifest[`${actionKey}#adminOnly`]).toBeUndefined();
  });

  it("follows namespace re-exports only when the namespace is consumed", async () => {
    const app = await fixture({
      "app/actions.ts": `'use server'; export async function first() {} export async function second() {}`,
      "app/barrel.ts": `export * as actions from "./actions";`,
      "app/page.tsx": `import { actions } from "./barrel"; export default function Page() { return actions.first; }`,
    });

    const manifest = await buildStaticActionOwnerManifest({
      mode: "production",
      root: app.root,
      routes: [route("/", path.join(app.root, "app/page.tsx"))],
      resolve: app.resolve,
    });

    const actionKey = productionKey("app/actions.ts");
    expect(manifest[`${actionKey}#first`]).toEqual(["/"]);
    expect(manifest[`${actionKey}#second`]).toEqual(["/"]);
  });

  // Ported from Next.js: test/e2e/app-dir/app-external/app/action/client/page.js
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-external/app/action/client/page.js
  it("maps server actions imported from packages", async () => {
    const app = await fixture({
      "app/page.tsx": `import { action1 } from "server-action-mod"; export default function Page() { return action1; }`,
      "node_modules/server-action-mod/index.js": `'use server'; export async function action1() {}`,
      "node_modules/server-action-mod/package.json": `{"name":"server-action-mod","type":"module"}`,
    });
    const packageEntry = path.join(app.root, "node_modules/server-action-mod/index.js");
    const resolve = async (specifier: string, importer?: string) => {
      if (specifier === "server-action-mod") return { id: packageEntry };
      return app.resolve(specifier, importer);
    };

    const manifest = await buildStaticActionOwnerManifest({
      mode: "production",
      root: app.root,
      routes: [route("/", path.join(app.root, "app/page.tsx"))],
      resolve,
    });

    expect(manifest[`${productionKey("node_modules/server-action-mod/index.js")}#action1`]).toEqual(
      ["/"],
    );
  });

  it("does not mistake inline action directives for module-level directives", async () => {
    const app = await fixture({
      "app/page.tsx": `export default function Page() {\n  async function action() {\n    "use server";\n  }\n  return action;\n}`,
    });
    const pagePath = path.join(app.root, "app/page.tsx");

    const manifest = await buildStaticActionOwnerManifest({
      mode: "production",
      root: app.root,
      routes: [route("/", pagePath)],
      resolve: app.resolve,
    });
    const pageKey = productionKey("app/page.tsx");

    expect(manifest[pageKey]).toEqual(["/"]);
    expect(manifest[`${pageKey}#default`]).toBeUndefined();
  });

  it("ignores type-only and commented imports when assigning action ownership", async () => {
    const app = await fixture({
      "app/admin-actions.ts": `'use server'; export async function adminOnly() {}`,
      "app/page.tsx": `import type { adminOnly } from "./admin-actions";
// import { adminOnly } from "./admin-actions";
const example = 'import { adminOnly } from "./admin-actions"';
const template = \`
import { adminOnly } from "./admin-actions";
\`;
export default function Page() { return example + template; }`,
    });

    const manifest = await buildStaticActionOwnerManifest({
      mode: "production",
      root: app.root,
      routes: [route("/", path.join(app.root, "app/page.tsx"))],
      resolve: app.resolve,
    });

    expect(manifest[`${productionKey("app/admin-actions.ts")}#adminOnly`]).toBeUndefined();
  });

  it("uses final plugin metadata only for actions defined in route components", () => {
    expect(
      buildActionOwnerManifest({
        moduleInfo: {
          getModuleInfo() {
            return null;
          },
        },
        routes: [route("/", "/app/page.tsx")],
        serverReferences: [
          {
            exportNames: ["$$hoist_0_inline"],
            importId: "/app/page.tsx",
            referenceKey: "inline-key",
          },
          {
            exportNames: ["importedAction"],
            importId: "/app/actions.ts",
            referenceKey: "imported-key",
          },
        ],
        staticOwners: {},
      }),
    ).toEqual({
      "inline-key": ["/"],
      "inline-key#$$hoist_0_inline": ["/"],
    });
  });

  it("accepts exact plugin references imported through client component boundaries", () => {
    expect(
      buildActionOwnerManifest({
        moduleInfo: {
          getModuleInfo(id) {
            return id === "/app/page.tsx" ? { importedIds: [] } : null;
          },
        },
        routes: [route("/", "/app/page.tsx")],
        serverReferences: [
          {
            exportNames: ["adminOnly"],
            importId: "/app/admin-actions.ts",
            referenceKey: "admin-key",
          },
        ],
        staticOwners: { "admin-key#adminOnly": ["/"] },
      }),
    ).toEqual({ "admin-key#adminOnly": ["/"] });
  });

  it("accepts actions reachable through the final dynamic import graph", () => {
    expect(
      buildActionOwnerManifest({
        moduleInfo: {
          getModuleInfo(id) {
            return id === "/app/page.tsx"
              ? { dynamicImportedIds: ["/app/actions.ts"], importedIds: [] }
              : { importedIds: [] };
          },
        },
        routes: [route("/", "/app/page.tsx")],
        serverReferences: [
          {
            exportNames: ["submit"],
            importId: "/app/actions.ts",
            referenceKey: "action-key",
          },
        ],
        staticOwners: { "action-key#submit": ["/"] },
      }),
    ).toEqual({ "action-key#submit": ["/"] });
  });

  it("includes every route component that can own an inline action", () => {
    const base = route("/", "/app/page.tsx");
    const entryIds = actionOwnerRouteEntryIds({
      ...base,
      errorPath: "/app/error.tsx",
      errorPaths: ["/app/nested-error.tsx"],
      forbiddenPath: "/app/forbidden.tsx",
      forbiddenPaths: ["/app/nested-forbidden.tsx"],
      layoutErrorPaths: ["/app/layout-error.tsx"],
      layouts: ["/app/layout.tsx"],
      loadingPath: "/app/loading.tsx",
      notFoundPath: "/app/not-found.tsx",
      notFoundPaths: ["/app/nested-not-found.tsx"],
      parallelSlots: [
        {
          configLayoutPaths: ["/app/@slot/config-layout.tsx"],
          defaultPath: "/app/@slot/default.tsx",
          errorPath: "/app/@slot/error.tsx",
          interceptingRoutes: [
            {
              convention: "(.)",
              layoutPaths: [],
              pagePath: "/app/@slot/(.)modal/page.tsx",
              params: [],
              sourceMatchPattern: "/modal",
              targetPattern: "/modal",
            },
          ],
          layoutPath: "/app/@slot/layout.tsx",
          loadingPath: "/app/@slot/loading.tsx",
          pagePath: "/app/@slot/page.tsx",
        } as unknown as AppRoute["parallelSlots"][number],
      ],
      templates: ["/app/template.tsx"],
      unauthorizedPath: "/app/unauthorized.tsx",
      unauthorizedPaths: ["/app/nested-unauthorized.tsx"],
      siblingIntercepts: [
        {
          convention: "(.)",
          layoutPaths: ["/app/(.)modal/layout.tsx"],
          pagePath: "/app/(.)modal/page.tsx",
          params: [],
          sourceMatchPattern: "/",
          targetPattern: "/modal",
        },
      ],
    });

    expect(entryIds).toEqual([
      "/app/page.tsx",
      "/app/layout.tsx",
      "/app/template.tsx",
      "/app/loading.tsx",
      "/app/error.tsx",
      "/app/layout-error.tsx",
      "/app/nested-error.tsx",
      "/app/not-found.tsx",
      "/app/nested-not-found.tsx",
      "/app/forbidden.tsx",
      "/app/nested-forbidden.tsx",
      "/app/unauthorized.tsx",
      "/app/nested-unauthorized.tsx",
      "/app/@slot/page.tsx",
      "/app/@slot/default.tsx",
      "/app/@slot/layout.tsx",
      "/app/@slot/config-layout.tsx",
      "/app/@slot/loading.tsx",
      "/app/@slot/error.tsx",
      "/app/@slot/(.)modal/page.tsx",
      "/app/(.)modal/page.tsx",
      "/app/(.)modal/layout.tsx",
    ]);
  });
});
