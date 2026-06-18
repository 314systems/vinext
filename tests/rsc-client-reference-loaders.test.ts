import { describe, expect, it } from "vite-plus/test";
import { clientReferencesRequireRouterRuntime } from "../packages/vinext/src/plugins/rsc-client-reference-loaders.js";

function createSourceReader(entries: Record<string, string[] | null>) {
  return async (id: string) => entries[id] ?? null;
}

function createResolver(entries: Record<string, string>) {
  return async (source: string, importer: string) => {
    const id = entries[`${importer}:${source}`];
    return id === undefined ? null : { id };
  };
}

describe("client reference router runtime analysis", () => {
  const internalRoot = "/repo/packages/vinext/src";
  const routerRuntimeImportSpecifiers = new Set(["next/navigation"]);
  const routerRuntimeModuleIds = ["/repo/packages/vinext/src/shims/navigation.ts"];

  it("ignores vinext-owned client references", async () => {
    await expect(
      clientReferencesRequireRouterRuntime({
        clientReferenceIds: ["/repo/packages/vinext/src/shims/link.tsx"],
        readImportSpecifiers: createSourceReader({}),
        resolveImport: createResolver({}),
        internalRoot,
        routerRuntimeImportSpecifiers,
        routerRuntimeModuleIds,
      }),
    ).resolves.toBe(false);
  });

  it("detects transitive router imports from user client references", async () => {
    await expect(
      clientReferencesRequireRouterRuntime({
        clientReferenceIds: ["/repo/app/counter.tsx"],
        readImportSpecifiers: createSourceReader({
          "/repo/app/counter.tsx": ["./use-navigation"],
          "/repo/app/use-navigation.ts": ["next/navigation"],
        }),
        resolveImport: createResolver({
          "/repo/app/counter.tsx:./use-navigation": "/repo/app/use-navigation.ts",
        }),
        internalRoot,
        routerRuntimeImportSpecifiers,
        routerRuntimeModuleIds,
      }),
    ).resolves.toBe(true);
  });

  it("allows router-independent user client references", async () => {
    await expect(
      clientReferencesRequireRouterRuntime({
        clientReferenceIds: ["/repo/app/counter.tsx"],
        readImportSpecifiers: createSourceReader({
          "/repo/app/counter.tsx": ["react"],
          "/repo/node_modules/react/index.js": [],
        }),
        resolveImport: createResolver({
          "/repo/app/counter.tsx:react": "/repo/node_modules/react/index.js",
        }),
        internalRoot,
        routerRuntimeImportSpecifiers,
        routerRuntimeModuleIds,
      }),
    ).resolves.toBe(false);
  });

  it("falls back to the full runtime when the graph is incomplete", async () => {
    await expect(
      clientReferencesRequireRouterRuntime({
        clientReferenceIds: ["/repo/app/counter.tsx"],
        readImportSpecifiers: createSourceReader({}),
        resolveImport: createResolver({}),
        internalRoot,
        routerRuntimeImportSpecifiers,
        routerRuntimeModuleIds,
      }),
    ).resolves.toBe(true);
  });
});
