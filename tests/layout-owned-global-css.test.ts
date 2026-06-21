import path from "node:path";
import { describe, expect, it } from "vitest";
import { createLayoutOwnedGlobalCssPlugin } from "../packages/vinext/src/plugins/layout-owned-global-css.js";

function createContext(environmentName: string, resolvedId: string) {
  return {
    environment: { name: environmentName },
    async resolve() {
      return { id: resolvedId };
    },
  };
}

describe("layout-owned global CSS", () => {
  it("deduplicates descendant client imports without affecting siblings or CSS Modules", async () => {
    const appDir = path.resolve("/app");
    const plugin = createLayoutOwnedGlobalCssPlugin(() => appDir);
    const resolveId =
      typeof plugin.resolveId === "object" ? plugin.resolveId.handler : plugin.resolveId;
    expect(resolveId).toBeTypeOf("function");

    const stylesheet = path.join(appDir, "dashboard", "global.css");
    const layout = path.join(appDir, "dashboard", "layout.tsx");
    const descendant = path.join(appDir, "dashboard", "widget.tsx");
    const sibling = path.join(appDir, "marketing", "widget.tsx");

    await expect(
      resolveId!.call(createContext("rsc", stylesheet) as never, "./global.css", layout, {
        isEntry: false,
      }),
    ).resolves.toEqual({ id: stylesheet });

    const dedupedId = await resolveId!.call(
      createContext("client", stylesheet) as never,
      "./global.css",
      descendant,
      { isEntry: false },
    );
    expect(typeof dedupedId).toBe("string");
    if (typeof dedupedId !== "string") throw new Error("Expected a virtual stylesheet id");
    expect(dedupedId.slice(1)).toMatch(/^vinext:layout-owned-global-css\/[a-f0-9]{16}\.css$/);
    expect(dedupedId.charCodeAt(0)).toBe(0);

    await expect(
      resolveId!.call(
        createContext("client", stylesheet) as never,
        "../dashboard/global.css",
        sibling,
        { isEntry: false },
      ),
    ).resolves.toBeNull();

    const moduleStylesheet = path.join(appDir, "dashboard", "widget.module.css");
    await expect(
      resolveId!.call(
        createContext("client", moduleStylesheet) as never,
        "./widget.module.css",
        descendant,
        { isEntry: false },
      ),
    ).resolves.toBeNull();
  });
});
