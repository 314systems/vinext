import { describe, expect, it, vi } from "vite-plus/test";
import {
  createAppRouteRuntimePlugin,
  withAppRouteRuntime,
} from "../packages/vinext/src/plugins/app-route-runtime.js";

function hookHandler<T>(hook: T | { handler: T }): T {
  return typeof hook === "object" && hook !== null && "handler" in hook ? hook.handler : hook;
}

describe("App route runtime module graph", () => {
  it("propagates the edge runtime through server-side user imports", async () => {
    const plugin = createAppRouteRuntimePlugin(() => "/app");
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
    expect(result).toEqual({ id: "/app/shared.ts?__vinext_app_runtime=edge" });
  });

  it("replaces NEXT_RUNTIME only inside a runtime-qualified server module", () => {
    const plugin = createAppRouteRuntimePlugin(() => "/app");
    const code = `export const runtime = process.env.NEXT_RUNTIME`;
    const transform = hookHandler(plugin.transform!);
    const result = transform.call(
      {} as ThisParameterType<typeof transform>,
      code,
      withAppRouteRuntime("/app/shared.ts", "edge"),
    );

    expect(result).toEqual({ code: `export const runtime = "edge"`, map: null });
  });

  it("does not propagate the runtime into dependencies", async () => {
    const plugin = createAppRouteRuntimePlugin(() => "/app");
    const resolve = vi.fn(async () => ({ id: "/app/node_modules/pkg/index.js" }));
    const resolveId = hookHandler(plugin.resolveId!);
    const result = await resolveId.call(
      { resolve } as unknown as ThisParameterType<typeof resolveId>,
      "pkg",
      withAppRouteRuntime("/app/edge/page.tsx", "edge"),
      { attributes: {}, isEntry: false },
    );

    expect(result).toEqual({ id: "/app/node_modules/pkg/index.js" });
  });
});
