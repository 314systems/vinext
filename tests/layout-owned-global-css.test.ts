import path from "node:path";
import { describe, expect, it } from "vitest";
import { createLayoutOwnedGlobalCssPlugin } from "../packages/vinext/src/plugins/layout-owned-global-css.js";

function createContext(
  environmentName: string,
  resolvedIds:
    | Record<string, string | { id: string; external?: boolean }>
    | string
    | ((source: string, importer?: string) => string | { id: string; external?: boolean } | null),
) {
  return {
    environment: { name: environmentName },
    async resolve(source: string, importer?: string) {
      const resolved =
        typeof resolvedIds === "function"
          ? resolvedIds(source, importer)
          : typeof resolvedIds === "string"
            ? resolvedIds
            : resolvedIds[source];
      if (!resolved) return null;
      return typeof resolved === "string" ? { id: resolved } : resolved;
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

  it("keeps CSS when the same shared module is consumed outside the owning layout", async () => {
    const appDir = path.resolve("/project/app");
    const plugin = createLayoutOwnedGlobalCssPlugin(() => appDir);
    const resolveId =
      typeof plugin.resolveId === "object" ? plugin.resolveId.handler : plugin.resolveId;
    expect(resolveId).toBeTypeOf("function");

    const dashboardLayout = path.join(appDir, "dashboard", "layout.tsx");
    const marketingPage = path.join(appDir, "marketing", "page.tsx");
    const sharedClient = path.resolve("/project/src/components/shared-client.tsx");
    const sharedStyles = path.resolve("/project/src/components/shared.css");

    for (const importer of [dashboardLayout, marketingPage]) {
      await resolveId!.call(
        createContext("rsc", { "@shared/client": sharedClient }) as never,
        "@shared/client",
        importer,
        { isEntry: false },
      );
    }
    await resolveId!.call(
      createContext("rsc", { "./shared.css": sharedStyles }) as never,
      "./shared.css",
      sharedClient,
      { isEntry: false },
    );

    await expect(
      resolveId!.call(
        createContext("client", { "./shared.css": sharedStyles }) as never,
        "./shared.css",
        sharedClient,
        { isEntry: false },
      ),
    ).resolves.toBeNull();
  });

  it("deduplicates when every shared-module consumer inherits the same layout", async () => {
    const appDir = path.resolve("/project/app");
    const plugin = createLayoutOwnedGlobalCssPlugin(() => appDir);
    const resolveId =
      typeof plugin.resolveId === "object" ? plugin.resolveId.handler : plugin.resolveId;
    expect(resolveId).toBeTypeOf("function");

    const layout = path.join(appDir, "page", "layout.tsx");
    const helper = path.join(appDir, "page", "shared-layout-styles.tsx");
    const inner = path.join(appDir, "page", "inner.tsx");
    const sharedClient = path.resolve("/project/src/components/shared-client.tsx");
    const sharedStyles = path.resolve("/project/src/components/shared.css");

    for (const [source, importer, resolved] of [
      ["./shared-layout-styles", layout, helper],
      ["./inner", layout, inner],
      ["@shared/client", helper, sharedClient],
      ["@shared/client", inner, sharedClient],
      ["./shared.css", sharedClient, sharedStyles],
    ] as const) {
      await resolveId!.call(
        createContext("rsc", { [source]: resolved }) as never,
        source,
        importer,
        { isEntry: false },
      );
    }

    await expect(
      resolveId!.call(
        createContext("client", { "./shared.css": sharedStyles }) as never,
        "./shared.css",
        `${sharedClient}?v=client`,
        { isEntry: false },
      ),
    ).resolves.toSatisfy((id: unknown) => typeof id === "string" && id.charCodeAt(0) === 0);
  });

  it("traverses bounded external source packages for layout-owned CSS", async () => {
    const fixtureRoot = await import("node:fs/promises").then((fs) =>
      fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "vinext-layout-css-")),
    );
    const fs = await import("node:fs/promises");
    try {
      const appDir = path.join(fixtureRoot, "app");
      const layout = path.join(appDir, "dashboard", "layout.tsx");
      const packageEntry = path.join(fixtureRoot, "node_modules", "design-system", "index.js");
      const packageHelper = path.join(fixtureRoot, "node_modules", "design-system", "helper.js");
      const packageStyles = path.join(fixtureRoot, "node_modules", "design-system", "styles.css");
      await fs.mkdir(path.dirname(packageEntry), { recursive: true });
      await fs.writeFile(packageEntry, `export { default } from "./helper.js";\n`);
      await fs.writeFile(
        packageHelper,
        `import "./styles.css";\nexport default function Widget() {}\n`,
      );
      await fs.writeFile(packageStyles, `.external-layout-style { color: green; }\n`);

      const plugin = createLayoutOwnedGlobalCssPlugin(() => appDir);
      const resolveId =
        typeof plugin.resolveId === "object" ? plugin.resolveId.handler : plugin.resolveId;
      expect(resolveId).toBeTypeOf("function");

      await resolveId!.call(
        createContext("rsc", {
          "design-system": { id: packageEntry, external: true },
        }) as never,
        "design-system",
        layout,
        { isEntry: false },
      );

      await expect(
        resolveId!.call(
          createContext("client", { "./styles.css": packageStyles }) as never,
          "./styles.css",
          packageHelper,
          { isEntry: false },
        ),
      ).resolves.toSatisfy((id: unknown) => typeof id === "string" && id.charCodeAt(0) === 0);
    } finally {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("ignores import-like comments and strings while scanning external packages", async () => {
    const fs = await import("node:fs/promises");
    const fixtureRoot = await fs.mkdtemp(
      path.join(process.env.TMPDIR ?? "/tmp", "vinext-layout-css-lexer-"),
    );
    try {
      const appDir = path.join(fixtureRoot, "app");
      const layout = path.join(appDir, "layout.tsx");
      const packageEntry = path.join(fixtureRoot, "node_modules", "design-system", "index.js");
      const fakeStyles = path.join(fixtureRoot, "node_modules", "design-system", "fake.css");
      await fs.mkdir(path.dirname(packageEntry), { recursive: true });
      await fs.writeFile(
        packageEntry,
        `// import "./fake.css";\nconst example = 'export { default } from "./fake.css"';\nexport default example;\n`,
      );
      await fs.writeFile(fakeStyles, `.fake { color: red; }\n`);

      const plugin = createLayoutOwnedGlobalCssPlugin(() => appDir);
      const resolveId =
        typeof plugin.resolveId === "object" ? plugin.resolveId.handler : plugin.resolveId;
      expect(resolveId).toBeTypeOf("function");

      await resolveId!.call(
        createContext("rsc", { "design-system": { id: packageEntry, external: true } }) as never,
        "design-system",
        layout,
        { isEntry: false },
      );

      await expect(
        resolveId!.call(
          createContext("client", { "./fake.css": fakeStyles }) as never,
          "./fake.css",
          packageEntry,
          { isEntry: false },
        ),
      ).resolves.toBeNull();
    } finally {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("follows bare package re-exports through Vite resolution", async () => {
    const fs = await import("node:fs/promises");
    const fixtureRoot = await fs.mkdtemp(
      path.join(process.env.TMPDIR ?? "/tmp", "vinext-layout-css-bare-"),
    );
    try {
      const appDir = path.join(fixtureRoot, "app");
      const layout = path.join(appDir, "layout.tsx");
      const packageA = path.join(fixtureRoot, "node_modules", "package-a", "index.js");
      const packageB = path.join(fixtureRoot, "node_modules", "package-b", "index.js");
      const packageStyles = path.join(fixtureRoot, "node_modules", "package-b", "styles.css");
      await fs.mkdir(path.dirname(packageA), { recursive: true });
      await fs.mkdir(path.dirname(packageB), { recursive: true });
      await fs.writeFile(packageA, `export { default } from "package-b";\n`);
      await fs.writeFile(packageB, `import "./styles.css";\nexport default function Widget() {}\n`);
      await fs.writeFile(packageStyles, `.bare-package { color: green; }\n`);

      const resolutions = new Map([
        ["package-a", { id: packageA, external: true }],
        ["package-b", { id: packageB, external: true }],
        ["./styles.css", { id: packageStyles }],
      ]);
      const plugin = createLayoutOwnedGlobalCssPlugin(() => appDir);
      const resolveId =
        typeof plugin.resolveId === "object" ? plugin.resolveId.handler : plugin.resolveId;

      await resolveId!.call(
        createContext("rsc", (source) => resolutions.get(source) ?? null) as never,
        "package-a",
        layout,
        { isEntry: false },
      );

      await expect(
        resolveId!.call(
          createContext("client", { "./styles.css": packageStyles }) as never,
          "./styles.css",
          packageB,
          { isEntry: false },
        ),
      ).resolves.toSatisfy((id: unknown) => typeof id === "string" && id.charCodeAt(0) === 0);
    } finally {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("scans each external package root independently", async () => {
    const fs = await import("node:fs/promises");
    const fixtureRoot = await fs.mkdtemp(
      path.join(process.env.TMPDIR ?? "/tmp", "vinext-layout-css-roots-"),
    );
    try {
      const appDir = path.join(fixtureRoot, "app");
      const layout = path.join(appDir, "layout.tsx");
      const resolutions = new Map<string, string | { id: string; external?: boolean }>();
      const packageData: Array<{ entry: string; styles: string }> = [];
      for (const packageName of ["package-a", "package-b"]) {
        const entry = path.join(fixtureRoot, "node_modules", packageName, "index.js");
        const styles = path.join(fixtureRoot, "node_modules", packageName, "styles.css");
        await fs.mkdir(path.dirname(entry), { recursive: true });
        await fs.writeFile(entry, `import "./styles.css";\nexport default {};\n`);
        await fs.writeFile(styles, `.${packageName} { color: green; }\n`);
        resolutions.set(packageName, { id: entry, external: true });
        resolutions.set(`${entry}:./styles.css`, styles);
        packageData.push({ entry, styles });
      }

      const plugin = createLayoutOwnedGlobalCssPlugin(() => appDir);
      const resolveId =
        typeof plugin.resolveId === "object" ? plugin.resolveId.handler : plugin.resolveId;
      const context = createContext(
        "rsc",
        (source, importer) =>
          resolutions.get(importer ? `${importer}:${source}` : source) ??
          resolutions.get(source) ??
          null,
      );
      for (const packageName of ["package-a", "package-b"]) {
        await resolveId!.call(context as never, packageName, layout, { isEntry: false });
      }

      for (const { entry, styles } of packageData) {
        await expect(
          resolveId!.call(
            createContext("client", { "./styles.css": styles }) as never,
            "./styles.css",
            entry,
            { isEntry: false },
          ),
        ).resolves.toSatisfy((id: unknown) => typeof id === "string" && id.charCodeAt(0) === 0);
      }
    } finally {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
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

  it("does not propagate layout ownership through dynamic imports", async () => {
    const appDir = path.resolve("/project/app");
    const plugin = createLayoutOwnedGlobalCssPlugin(() => appDir);
    const resolveId =
      typeof plugin.resolveId === "object" ? plugin.resolveId.handler : plugin.resolveId;
    const resolveDynamicImport =
      typeof plugin.resolveDynamicImport === "object"
        ? plugin.resolveDynamicImport.handler
        : plugin.resolveDynamicImport;
    expect(resolveId).toBeTypeOf("function");
    expect(resolveDynamicImport).toBeTypeOf("function");

    const layout = path.join(appDir, "dashboard", "layout.tsx");
    const dynamicClient = path.join(appDir, "dashboard", "dynamic-client.tsx");
    const layoutStylesheet = path.join(appDir, "dashboard", "layout.css");
    const stylesheet = path.join(appDir, "dashboard", "dynamic.css");

    await resolveId!.call(createContext("rsc", layoutStylesheet) as never, "./layout.css", layout, {
      isEntry: false,
    });
    await resolveDynamicImport!.call(
      createContext("rsc", dynamicClient) as never,
      "./dynamic-client",
      layout,
    );
    await resolveId!.call(
      createContext("rsc", stylesheet) as never,
      "./dynamic.css",
      dynamicClient,
      { isEntry: false },
    );

    await expect(
      resolveId!.call(
        createContext("client", stylesheet) as never,
        "./dynamic.css",
        dynamicClient,
        { isEntry: false },
      ),
    ).resolves.toBeNull();
  });

  it("keeps shared CSS when a transitive Pages route also consumes the module", async () => {
    const appDir = path.resolve("/project/app");
    const pagesDir = path.resolve("/project/pages");
    const plugin = createLayoutOwnedGlobalCssPlugin(
      () => appDir,
      () => pagesDir,
    );
    const resolveId =
      typeof plugin.resolveId === "object" ? plugin.resolveId.handler : plugin.resolveId;
    expect(resolveId).toBeTypeOf("function");

    const layout = path.join(appDir, "dashboard", "layout.tsx");
    const appHelper = path.join(appDir, "dashboard", "shared.tsx");
    const pagesRoute = path.join(pagesDir, "shared.tsx");
    const pagesHelper = path.resolve("/project/src/pages-shared-helper.tsx");
    const sharedClient = path.resolve("/project/src/components/shared-client.tsx");
    const stylesheet = path.resolve("/project/src/components/shared.css");

    for (const [source, importer, resolved] of [
      ["./shared", layout, appHelper],
      ["@shared/client", appHelper, sharedClient],
      ["./shared.css", sharedClient, stylesheet],
    ] as const) {
      await resolveId!.call(
        createContext("rsc", { [source]: resolved }) as never,
        source,
        importer,
        { isEntry: false },
      );
    }
    await resolveId!.call(
      createContext("ssr", { "@shared/helper": pagesHelper }) as never,
      "@shared/helper",
      pagesRoute,
      { isEntry: false },
    );
    await resolveId!.call(
      createContext("ssr", { "@shared/client": sharedClient }) as never,
      "@shared/client",
      pagesHelper,
      { isEntry: false },
    );

    await expect(
      resolveId!.call(
        createContext("client", { "./shared.css": stylesheet }) as never,
        "./shared.css",
        sharedClient,
        { isEntry: false },
      ),
    ).resolves.toBeNull();
  });
});
