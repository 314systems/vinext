import path from "node:path";
import { describe, expect, it } from "vitest";
import { createLayoutOwnedGlobalCssPlugin } from "../packages/vinext/src/plugins/layout-owned-global-css.js";

function createContext(environmentName: string, resolvedIds: Record<string, string> | string) {
  return {
    environment: { name: environmentName },
    async resolve(source: string) {
      return { id: typeof resolvedIds === "string" ? resolvedIds : resolvedIds[source] };
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

  it("tracks indirect layout and template imports without conflating CSS queries", async () => {
    const appDir = path.resolve("/app");
    const plugin = createLayoutOwnedGlobalCssPlugin(() => appDir);
    const resolveId =
      typeof plugin.resolveId === "object" ? plugin.resolveId.handler : plugin.resolveId;
    expect(resolveId).toBeTypeOf("function");

    const layout = path.join(appDir, "dashboard", "layout.tsx");
    const helper = path.join(appDir, "dashboard", "shared.tsx");
    const stylesheet = path.join(appDir, "dashboard", "global.css");
    const template = path.join(appDir, "account", "template.tsx");
    const templateStylesheet = path.join(appDir, "account", "template.css");

    await resolveId!.call(
      createContext("rsc", { "./global.css": stylesheet }) as never,
      "./global.css",
      helper,
      { isEntry: false },
    );
    await resolveId!.call(
      createContext("rsc", { "./shared": helper }) as never,
      "./shared",
      layout,
      {
        isEntry: false,
      },
    );
    await resolveId!.call(
      createContext("rsc", { "./template.css": templateStylesheet }) as never,
      "./template.css",
      template,
      { isEntry: false },
    );
    await resolveId!.call(
      createContext("rsc", { "./global.css?inline": `${stylesheet}?inline` }) as never,
      "./global.css?inline",
      layout,
      { isEntry: false },
    );

    await expect(
      resolveId!.call(
        createContext("client", { "./global.css": stylesheet }) as never,
        "./global.css",
        path.join(appDir, "dashboard", "lazy.tsx"),
        { isEntry: false },
      ),
    ).resolves.toSatisfy(
      (id: unknown) =>
        typeof id === "string" &&
        id.charCodeAt(0) === 0 &&
        /^vinext:layout-owned-global-css\/[a-f0-9]{16}\.css$/.test(id.slice(1)),
    );
    await expect(
      resolveId!.call(
        createContext("client", { "./template.css": templateStylesheet }) as never,
        "./template.css",
        path.join(appDir, "account", "lazy.tsx"),
        { isEntry: false },
      ),
    ).resolves.toSatisfy(
      (id: unknown) =>
        typeof id === "string" &&
        id.charCodeAt(0) === 0 &&
        /^vinext:layout-owned-global-css\/[a-f0-9]{16}\.css$/.test(id.slice(1)),
    );
    await expect(
      resolveId!.call(
        createContext("client", { "./global.css?inline": `${stylesheet}?inline` }) as never,
        "./global.css?inline",
        path.join(appDir, "dashboard", "inline.ts"),
        { isEntry: false },
      ),
    ).resolves.toBeNull();
  });

  it("tracks shared modules outside app while preserving route ownership", async () => {
    const appDir = path.resolve("/project/app");
    const plugin = createLayoutOwnedGlobalCssPlugin(() => appDir);
    const resolveId =
      typeof plugin.resolveId === "object" ? plugin.resolveId.handler : plugin.resolveId;
    expect(resolveId).toBeTypeOf("function");

    const dashboardLayout = path.join(appDir, "dashboard", "layout.tsx");
    const dashboardClient = path.resolve("/project/src/components/dashboard-client.tsx");
    const marketingClient = path.resolve("/project/src/components/marketing-client.tsx");
    const sharedStyles = path.resolve("/project/packages/design-system/global.css");

    await resolveId!.call(
      createContext("rsc", { "@shared/dashboard-client": dashboardClient }) as never,
      "@shared/dashboard-client",
      dashboardLayout,
      { isEntry: false },
    );
    await resolveId!.call(
      createContext("rsc", { "@design/global.css": sharedStyles }) as never,
      "@design/global.css",
      dashboardClient,
      { isEntry: false },
    );

    await expect(
      resolveId!.call(
        createContext("client", { "@design/global.css": sharedStyles }) as never,
        "@design/global.css",
        dashboardClient,
        { isEntry: false },
      ),
    ).resolves.toSatisfy(
      (id: unknown) =>
        typeof id === "string" &&
        id.charCodeAt(0) === 0 &&
        /^vinext:layout-owned-global-css\/[a-f0-9]{16}\.css$/.test(id.slice(1)),
    );
    await expect(
      resolveId!.call(
        createContext("client", { "@design/global.css": sharedStyles }) as never,
        "@design/global.css",
        marketingClient,
        { isEntry: false },
      ),
    ).resolves.toBeNull();
  });

  it("only excludes Vite queries that return CSS as a value", async () => {
    const appDir = path.resolve("/app");
    const plugin = createLayoutOwnedGlobalCssPlugin(() => appDir);
    const resolveId =
      typeof plugin.resolveId === "object" ? plugin.resolveId.handler : plugin.resolveId;
    expect(resolveId).toBeTypeOf("function");

    const layout = path.join(appDir, "dashboard", "layout.tsx");
    const client = path.join(appDir, "dashboard", "client.tsx");
    const stylesheet = path.join(appDir, "dashboard", "global.css");

    for (const query of ["?cache=1", "?theme=dark#fragment"]) {
      const source = `./global.css${query}`;
      const resolved = `${stylesheet}${query}`;
      await resolveId!.call(createContext("rsc", { [source]: resolved }) as never, source, layout, {
        isEntry: false,
      });
      await expect(
        resolveId!.call(createContext("client", { [source]: resolved }) as never, source, client, {
          isEntry: false,
        }),
      ).resolves.toSatisfy((id: unknown) => typeof id === "string" && id.charCodeAt(0) === 0);
    }

    for (const query of ["?inline", "?raw", "?url", "?cache=1&inline"] as const) {
      const source = `./global.css${query}`;
      await expect(
        resolveId!.call(
          createContext("client", { [source]: `${stylesheet}${query}` }) as never,
          source,
          client,
          { isEntry: false },
        ),
      ).resolves.toBeNull();
    }
  });
});
