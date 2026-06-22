import { createServer, type Plugin } from "vite";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  createAppRouteRuntimePlugin,
  withAppRouteRuntime,
} from "../packages/vinext/src/plugins/app-route-runtime.js";

function hookHandler<T>(hook: T | { handler: T }): T {
  return typeof hook === "object" && hook !== null && "handler" in hook ? hook.handler : hook;
}

function transformOutput(result: unknown): { code: string; map: unknown } {
  expect(result).toEqual(
    expect.objectContaining({ code: expect.any(String), map: expect.anything() }),
  );
  return result as { code: string; map: unknown };
}

describe("App route runtime module graph", () => {
  it("propagates the edge runtime through server-side user imports", async () => {
    const plugin = createAppRouteRuntimePlugin();
    const resolve = vi.fn(async () => ({ id: "/app/shared.ts" }));
    const resolveId = hookHandler(plugin.resolveId!);
    const result = await resolveId.call(
      { resolve } as unknown as ThisParameterType<typeof resolveId>,
      "../shared",
      withAppRouteRuntime("/app/edge/page.tsx", "edge"),
      { attributes: {}, isEntry: false },
    );

    expect(resolve).toHaveBeenCalledWith("../shared", "/app/edge/page.tsx", {
      attributes: {},
      isEntry: false,
      skipSelf: true,
    });
    expect(result).toEqual({
      id: "/app/shared.ts?__vinext_app_runtime=edge",
    });
  });

  it("replaces NEXT_RUNTIME only inside a runtime-qualified server module", () => {
    const plugin = createAppRouteRuntimePlugin();
    const code = `export const runtime = process.env.NEXT_RUNTIME`;
    const transform = hookHandler(plugin.transform!);
    const result = transform.call(
      {} as ThisParameterType<typeof transform>,
      code,
      withAppRouteRuntime("/app/shared.ts", "edge"),
    );

    expect(transformOutput(result).code).toBe(`export const runtime = "edge"`);
  });

  it("does not replace NEXT_RUNTIME text in strings or comments", () => {
    const plugin = createAppRouteRuntimePlugin();
    const code = [
      `const text = "process.env.NEXT_RUNTIME"`,
      `// process.env.NEXT_RUNTIME`,
      `export const runtime = process.env.NEXT_RUNTIME`,
    ].join("\n");
    const transform = hookHandler(plugin.transform!);
    const result = transform.call(
      {} as ThisParameterType<typeof transform>,
      code,
      withAppRouteRuntime("/app/shared.ts", "nodejs"),
    );

    expect(transformOutput(result).code).toBe(
      [
        `const text = "process.env.NEXT_RUNTIME"`,
        `// process.env.NEXT_RUNTIME`,
        `export const runtime = "nodejs"`,
      ].join("\n"),
    );
  });

  it("propagates the runtime into dependencies", async () => {
    const plugin = createAppRouteRuntimePlugin();
    const resolve = vi.fn(async () => ({ id: "/app/node_modules/pkg/index.js" }));
    const resolveId = hookHandler(plugin.resolveId!);
    const result = await resolveId.call(
      { resolve } as unknown as ThisParameterType<typeof resolveId>,
      "pkg",
      withAppRouteRuntime("/app/edge/page.tsx", "edge"),
      { attributes: {}, isEntry: false },
    );

    expect(result).toEqual({
      id: "/app/node_modules/pkg/index.js?__vinext_app_runtime=edge",
    });
  });

  it("preserves query-based loader semantics while propagating the runtime", async () => {
    const plugin = createAppRouteRuntimePlugin();
    const resolve = vi.fn(async () => ({ id: "/app/message.ts?raw" }));
    const resolveId = hookHandler(plugin.resolveId!);
    const result = await resolveId.call(
      { resolve } as unknown as ThisParameterType<typeof resolveId>,
      "./message.ts?raw",
      withAppRouteRuntime("/app/edge/page.tsx", "edge"),
      { attributes: {}, isEntry: false },
    );

    expect(result).toEqual({
      id: "/app/message.ts?raw&__vinext_app_runtime=edge",
    });
    expect(plugin.load).toBeUndefined();
  });

  it.each([
    ["Node built-in", "node:fs"],
    ["configured external package", "external-package"],
  ])("preserves a resolved %s", async (_label, externalId) => {
    const plugin = createAppRouteRuntimePlugin();
    const resolve = vi.fn(async () => ({ id: externalId, external: true }));
    const resolveId = hookHandler(plugin.resolveId!);
    const result = await resolveId.call(
      { resolve } as unknown as ThisParameterType<typeof resolveId>,
      externalId,
      withAppRouteRuntime("/app/edge/page.tsx", "edge"),
      { attributes: {}, isEntry: false },
    );

    expect(result).toEqual({ id: externalId, external: true });
  });

  it("transforms JavaScript returned by a virtual plugin loader", async () => {
    const virtualId = "\0runtime-generated";
    const dependencyId = "\0runtime-generated-dependency";
    const loaderQuery = "custom-loader=active";
    const loader: Plugin = {
      name: "test:runtime-generated-loader",
      resolveId(source, importer) {
        if (source === "./message.custom") return `${virtualId}?${loaderQuery}`;
        if (source === "./dependency.custom") {
          expect(importer).toBe(`${virtualId}?${loaderQuery}`);
          return dependencyId;
        }
      },
      load(id) {
        if (id.startsWith(`${virtualId}?`)) {
          return [
            `import dependencyRuntime from "./dependency.custom"`,
            `export default process.env.NEXT_RUNTIME + ":" + dependencyRuntime`,
          ].join("\n");
        }
        if (id.startsWith(`${dependencyId}?`)) return `export default process.env.NEXT_RUNTIME`;
      },
    };
    const server = await createServer({
      configFile: false,
      logLevel: "silent",
      plugins: [createAppRouteRuntimePlugin(), loader],
      server: { middlewareMode: true },
    });

    try {
      const pluginContainer = server.environments.ssr.pluginContainer;
      const resolved = await pluginContainer.resolveId(
        "./message.custom",
        withAppRouteRuntime("/app/edge/page.tsx", "edge"),
      );
      expect(resolved?.id).toBe(`${virtualId}?${loaderQuery}&__vinext_app_runtime=edge`);

      const loaded = await pluginContainer.load(resolved!.id);
      const code = typeof loaded === "string" ? loaded : loaded?.code;
      expect(code).toContain(`import dependencyRuntime from "./dependency.custom"`);

      const module = await server.ssrLoadModule(resolved!.id);
      expect(module.default).toBe("edge:edge");
    } finally {
      await server.close();
    }
  });

  it("does not qualify genuine non-JavaScript assets", async () => {
    const plugin = createAppRouteRuntimePlugin();
    const resolve = vi.fn(async () => ({ id: "/app/logo.svg" }));
    const resolveId = hookHandler(plugin.resolveId!);
    const result = await resolveId.call(
      { resolve } as unknown as ThisParameterType<typeof resolveId>,
      "./logo.svg",
      withAppRouteRuntime("/app/edge/page.tsx", "edge"),
      { attributes: {}, isEntry: false },
    );

    expect(result).toEqual({ id: "/app/logo.svg" });
  });

  it("does not qualify Vite RSC virtual modules with exact loader IDs", async () => {
    const plugin = createAppRouteRuntimePlugin();
    const virtualId = "\0virtual:vite-rsc/encryption-key";
    const resolve = vi.fn(async () => ({ id: virtualId }));
    const resolveId = hookHandler(plugin.resolveId!);
    const result = await resolveId.call(
      { resolve } as unknown as ThisParameterType<typeof resolveId>,
      "virtual:vite-rsc/encryption-key",
      withAppRouteRuntime("/app/edge/page.tsx", "edge"),
      { attributes: {}, isEntry: false },
    );

    expect(result).toEqual({ id: virtualId });
  });

  it("strips only runtime qualification from client modules", async () => {
    const plugin = createAppRouteRuntimePlugin();
    const resolve = vi.fn(async () => ({ id: "/app/client.tsx?raw&custom-loader=active" }));
    const resolveId = hookHandler(plugin.resolveId!);
    const result = await resolveId.call(
      { environment: { name: "client" }, resolve } as unknown as ThisParameterType<
        typeof resolveId
      >,
      withAppRouteRuntime("/app/client.tsx?raw&custom-loader=active", "edge"),
      undefined,
      { attributes: {}, isEntry: false },
    );

    expect(resolve).toHaveBeenCalledWith("/app/client.tsx?raw&custom-loader=active", undefined, {
      attributes: {},
      isEntry: false,
      skipSelf: true,
    });
    expect(result).toEqual({ id: "/app/client.tsx?raw&custom-loader=active" });
  });

  it("does not replace NEXT_RUNTIME in client transforms", () => {
    const plugin = createAppRouteRuntimePlugin();
    const code = `export const runtime = process.env.NEXT_RUNTIME`;
    const transform = hookHandler(plugin.transform!);
    const result = transform.call(
      { environment: { name: "client" } } as unknown as ThisParameterType<typeof transform>,
      code,
      withAppRouteRuntime("/app/client.tsx", "edge"),
    );

    expect(result).toBeNull();
  });
});
