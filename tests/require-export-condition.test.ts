import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import { createRequireExportConditionPlugin } from "../packages/vinext/src/plugins/require-export-condition.js";

async function withModule(content: string, run: (id: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vinext-require-condition-"));
  const id = path.join(root, "index.js");
  fs.writeFileSync(id, content);
  try {
    await run(id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function getTransform(plugin: ReturnType<typeof createRequireExportConditionPlugin>) {
  return plugin.transform as unknown as {
    handler: (
      this: { environment?: { name: string }; resolve: ReturnType<typeof vi.fn> },
      code: string,
      id: string,
    ) => Promise<{ code: string } | null>;
  };
}

describe("require export conditions", () => {
  it("rewrites client package requires using require-condition resolution", async () => {
    await withModule(`'use client'; module.exports = () => 'client';`, async (moduleId) => {
      const plugin = createRequireExportConditionPlugin();
      const resolve = vi.fn().mockImplementation(async (specifier: string) => {
        if (specifier === "client-pkg") return { id: moduleId };
        return null;
      });

      const result = await getTransform(plugin).handler.call(
        { environment: { name: "rsc" }, resolve },
        `const packageValue = require("client-pkg");
const relativeValue = require("./relative.js");
const dynamicValue = require(name);`,
        "/app/page.tsx",
      );

      expect(result?.code).toContain('require("virtual:vinext-require-condition:client-pkg")');
      expect(result?.code).toContain('require("./relative.js")');
      expect(result?.code).toContain("require(name)");

      const resolveId = plugin.resolveId as unknown as (
        this: { resolve: typeof resolve },
        id: string,
        importer: string,
      ) => Promise<unknown>;
      await expect(
        resolveId.call({ resolve }, "virtual:vinext-require-condition:client-pkg", "/app/page.tsx"),
      ).resolves.toBe("\0virtual:vinext-require-condition:client-pkg.vinext-require.js");
      expect(resolve).toHaveBeenCalledWith("client-pkg", "/app/page.tsx", {
        skipSelf: true,
        kind: "require-call",
      });
    });
  });

  it("leaves normal server and virtual requires to the existing pipeline", async () => {
    await withModule(`module.exports = { value: "server" };`, async (moduleId) => {
      const plugin = createRequireExportConditionPlugin();
      const resolve = vi.fn().mockImplementation(async (specifier: string) => {
        if (specifier === "server-pkg") return { id: moduleId };
        if (specifier === "server-only") {
          return { id: "\0virtual:vite-rsc/validate-imports/valid/server-only" };
        }
        return null;
      });

      const resolveId = plugin.resolveId as unknown as (
        this: { resolve: typeof resolve },
        id: string,
        importer: string,
      ) => Promise<unknown>;
      await expect(
        resolveId.call({ resolve }, "virtual:vinext-require-condition:server-pkg", "/app/page.tsx"),
      ).resolves.toEqual({ id: moduleId });
      await expect(
        resolveId.call(
          { resolve },
          "virtual:vinext-require-condition:server-only",
          "/app/page.tsx",
        ),
      ).resolves.toEqual({ id: "\0virtual:vite-rsc/validate-imports/valid/server-only" });
    });
  });

  it("loads external packages through createRequire at runtime", async () => {
    const plugin = createRequireExportConditionPlugin();
    const resolve = vi.fn().mockResolvedValue({ id: "external-pkg", external: true });
    const resolveId = plugin.resolveId as unknown as (
      this: { resolve: typeof resolve },
      id: string,
      importer: string,
    ) => Promise<string | null>;
    const resolvedProxyId = await resolveId.call(
      { resolve },
      "virtual:vinext-require-condition:external-pkg",
      "/app/page.tsx",
    );
    expect(resolvedProxyId).toBe(
      "\0virtual:vinext-require-condition:external-pkg.vinext-require.js",
    );

    const load = plugin.load as (id: string) => string | null;
    expect(load(resolvedProxyId ?? "")).toContain(')("external-pkg")');
  });

  it("preserves falsy client module defaults", async () => {
    await withModule(`'use client'; export default false;`, async (moduleId) => {
      const plugin = createRequireExportConditionPlugin();
      const resolve = vi.fn().mockResolvedValue({ id: moduleId });
      const resolveId = plugin.resolveId as unknown as (
        this: { resolve: typeof resolve },
        id: string,
        importer: string,
      ) => Promise<string | null>;
      const resolvedProxyId = await resolveId.call(
        { environment: { name: "rsc" }, resolve },
        "virtual:vinext-require-condition:client-pkg",
        "/app/page.tsx",
      );
      const load = plugin.load as (id: string) => string | null;

      expect(load(resolvedProxyId ?? "")).toContain(
        'const value = "default" in namespace ? namespace.default : namespace;',
      );
    });
  });

  it("leaves calls alone when require is locally bound", async () => {
    const plugin = createRequireExportConditionPlugin();
    const resolve = vi.fn();

    await expect(
      getTransform(plugin).handler.call(
        { environment: { name: "rsc" }, resolve },
        `function load(require: (id: string) => unknown) {
  return require("pkg");
}`,
        "/app/page.tsx",
      ),
    ).resolves.toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("does not rewrite requires outside the RSC environment", async () => {
    const plugin = createRequireExportConditionPlugin();
    const resolve = vi.fn();

    await expect(
      getTransform(plugin).handler.call(
        { environment: { name: "ssr" }, resolve },
        `const value = require("pkg");`,
        "/pages/index.tsx",
      ),
    ).resolves.toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });
});
