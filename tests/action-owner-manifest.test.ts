import { describe, expect, it } from "vite-plus/test";
import type { AppRoute } from "../packages/vinext/src/routing/app-route-graph.js";
import {
  actionOwnerRouteEntryIds,
  buildActionOwnerManifest,
  injectActionOwnerManifest,
} from "../packages/vinext/src/build/action-owner-manifest.js";

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
    siblingIntercepts: [],
    templates: [],
    unauthorizedPath: null,
    unauthorizedPaths: [],
  };
}

describe("server action owner manifest", () => {
  it("escapes action owner manifests embedded in generated JavaScript", () => {
    const injected = injectActionOwnerManifest(
      `function __VINEXT_ACTION_OWNERS() { return "__VINEXT_ACTION_OWNERS_STUB__"; }`,
      { "module#action</script>\u2028": ["/route&segment\u2029"] },
    );

    expect(injected).toContain("\\u003c/script\\u003e");
    expect(injected).toContain("\\u0026");
    expect(injected).toContain("\\u2028");
    expect(injected).toContain("\\u2029");
    expect(injected).not.toContain("</script>");
  });

  it("maps exact consumed action exports to each owning route", () => {
    const moduleGraph: Record<string, readonly string[]> = {
      "/app/page.tsx": ["/app/actions.ts"],
      "/app/admin/page.tsx": ["/app/admin-consumer.ts"],
      "/app/admin-consumer.ts": ["/app/actions.ts"],
    };

    expect(
      buildActionOwnerManifest({
        moduleInfo: {
          getModuleInfo(id) {
            return { importedIds: moduleGraph[id] ?? [] };
          },
        },
        routes: [route("/", "/app/page.tsx"), route("/admin", "/app/admin/page.tsx")],
        serverReferenceConsumers: {
          "/app/page.tsx": ["action-key#publicOnly"],
          "/app/admin-consumer.ts": ["action-key#adminOnly"],
        },
        serverReferences: [
          {
            exportNames: ["publicOnly", "adminOnly", "unrelated"],
            importId: "/app/actions.ts",
            referenceKey: "action-key",
          },
        ],
      }),
    ).toEqual({
      "action-key#adminOnly": ["/admin"],
      "action-key#publicOnly": ["/"],
    });
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
        serverReferenceConsumers: {},
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
        serverReferenceConsumers: {
          "/app/page.tsx": ["admin-key#adminOnly"],
        },
        serverReferences: [
          {
            exportNames: ["adminOnly"],
            importId: "/app/admin-actions.ts",
            referenceKey: "admin-key",
          },
        ],
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
        serverReferenceConsumers: {
          "/app/actions.ts": ["action-key#submit"],
        },
        serverReferences: [
          {
            exportNames: ["submit"],
            importId: "/app/actions.ts",
            referenceKey: "action-key",
          },
        ],
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
      templates: ["/app/template.tsx"],
      unauthorizedPath: "/app/unauthorized.tsx",
      unauthorizedPaths: ["/app/nested-unauthorized.tsx"],
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
