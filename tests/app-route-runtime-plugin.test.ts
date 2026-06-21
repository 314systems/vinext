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
      external: false,
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
      external: false,
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
      id: "/app/message.ts?raw=&__vinext_app_runtime=edge",
      external: false,
    });
    expect(plugin.load).toBeUndefined();
  });

  it("transforms JavaScript returned by another plugin loader", () => {
    const plugin = createAppRouteRuntimePlugin();
    const transform = hookHandler(plugin.transform!);
    const result = transform.call(
      {} as ThisParameterType<typeof transform>,
      `export default process.env.NEXT_RUNTIME`,
      withAppRouteRuntime("/app/generated.ts?custom-loader", "edge"),
    );

    expect(transformOutput(result).code).toBe(`export default "edge"`);
  });

  it("strips runtime qualification from client modules", async () => {
    const plugin = createAppRouteRuntimePlugin();
    const resolve = vi.fn(async () => ({ id: "/app/client.tsx" }));
    const resolveId = hookHandler(plugin.resolveId!);
    const result = await resolveId.call(
      { environment: { name: "client" }, resolve } as unknown as ThisParameterType<
        typeof resolveId
      >,
      withAppRouteRuntime("/app/client.tsx", "edge"),
      undefined,
      { attributes: {}, isEntry: false },
    );

    expect(result).toEqual({ id: "/app/client.tsx" });
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
