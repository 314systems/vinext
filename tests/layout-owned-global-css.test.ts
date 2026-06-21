import fs from "node:fs/promises";
import os from "node:os";
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

  it("keeps shared CSS before the separate hybrid Pages build starts", async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-layout-css-hybrid-"));
    const appDir = path.join(projectDir, "app");
    const pagesDir = path.join(projectDir, "pages");
    const sourceDir = path.join(projectDir, "src");
    await fs.mkdir(path.join(appDir, "dashboard"), { recursive: true });
    await fs.mkdir(pagesDir, { recursive: true });
    await fs.mkdir(sourceDir, { recursive: true });
    const appBuildPlugin = createLayoutOwnedGlobalCssPlugin(
      () => appDir,
      () => pagesDir,
    );
    const appResolveId =
      typeof appBuildPlugin.resolveId === "object"
        ? appBuildPlugin.resolveId.handler
        : appBuildPlugin.resolveId;
    expect(appResolveId).toBeTypeOf("function");

    const layout = path.join(appDir, "dashboard", "layout.tsx");
    const appHelper = path.join(appDir, "dashboard", "shared.tsx");
    const pagesRoute = path.join(pagesDir, "shared.tsx");
    const pagesHelper = path.join(sourceDir, "pages-shared-helper.tsx");
    const sharedClient = path.join(sourceDir, "shared-client.tsx");
    const stylesheet = path.join(sourceDir, "shared.css");

    await fs.writeFile(pagesRoute, `import "../src/pages-shared-helper";\n`);
    await fs.writeFile(pagesHelper, `import "./shared-client";\n`);
    await fs.writeFile(sharedClient, `import "./shared.css";\n`);
    await fs.writeFile(stylesheet, `.shared { color: teal; }\n`);

    const resolvedIds = (source: string, importer?: string) => {
      if (!importer) return null;
      const extensions = ["", ".ts", ".tsx", ".js", ".jsx"];
      const candidate = path.resolve(path.dirname(importer), source);
      for (const extension of extensions) {
        const resolved = `${candidate}${extension}`;
        if (resolved === pagesHelper || resolved === sharedClient || resolved === stylesheet) {
          return resolved;
        }
      }
      return null;
    };

    for (const [source, importer, resolved] of [
      ["./shared", layout, appHelper],
      ["@shared/client", appHelper, sharedClient],
      ["./shared.css", sharedClient, stylesheet],
    ] as const) {
      await appResolveId!.call(
        createContext("rsc", { [source]: resolved }) as never,
        source,
        importer,
        { isEntry: false },
      );
    }

    await expect(
      appResolveId!.call(
        createContext("client", resolvedIds) as never,
        "./shared.css",
        sharedClient,
        { isEntry: false },
      ),
    ).resolves.toBeNull();

    const pagesBuildPlugin = createLayoutOwnedGlobalCssPlugin(
      () => appDir,
      () => pagesDir,
    );
    const pagesResolveId =
      typeof pagesBuildPlugin.resolveId === "object"
        ? pagesBuildPlugin.resolveId.handler
        : pagesBuildPlugin.resolveId;
    expect(pagesResolveId).toBeTypeOf("function");

    await pagesResolveId!.call(
      createContext("ssr", resolvedIds) as never,
      "../src/pages-shared-helper",
      pagesRoute,
      { isEntry: false },
    );
    await pagesResolveId!.call(
      createContext("ssr", resolvedIds) as never,
      "./shared-client",
      pagesHelper,
      { isEntry: false },
    );

    await fs.rm(projectDir, { recursive: true, force: true });
  });

  it("pre-scans configured MDX Pages routes before the App client build", async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-layout-css-mdx-"));
    const appDir = path.join(projectDir, "app");
    const pagesDir = path.join(projectDir, "pages");
    const sourceDir = path.join(projectDir, "src");
    await fs.mkdir(path.join(appDir, "dashboard"), { recursive: true });
    await fs.mkdir(pagesDir, { recursive: true });
    await fs.mkdir(sourceDir, { recursive: true });

    const layout = path.join(appDir, "dashboard", "layout.tsx");
    const appHelper = path.join(appDir, "dashboard", "shared.tsx");
    const pagesRoute = path.join(pagesDir, "shared.mdx");
    const sharedClient = path.join(sourceDir, "shared-client.tsx");
    const stylesheet = path.join(sourceDir, "shared.css");
    await fs.writeFile(pagesRoute, `import Shared from "../src/shared-client"\n\n<Shared />\n`);
    await fs.writeFile(sharedClient, `import "./shared.css";\nexport default function Shared() {}`);
    await fs.writeFile(stylesheet, `.shared { color: teal; }\n`);

    const plugin = createLayoutOwnedGlobalCssPlugin(
      () => appDir,
      () => pagesDir,
      { getPageExtensions: () => ["mdx", "tsx"] },
    );
    const resolveId =
      typeof plugin.resolveId === "object" ? plugin.resolveId.handler : plugin.resolveId;
    const configResolved =
      typeof plugin.configResolved === "object"
        ? plugin.configResolved.handler
        : plugin.configResolved;
    await configResolved?.call(
      {} as never,
      {
        createResolver: () => async (source: string, importer?: string) => {
          if (!importer) return undefined;
          if (source === "../src/shared-client") return sharedClient;
          if (source === "./shared.css") return stylesheet;
          return undefined;
        },
      } as never,
    );

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

    await expect(
      resolveId!.call(createContext("client", stylesheet) as never, "./shared.css", sharedClient, {
        isEntry: false,
      }),
    ).resolves.toBeNull();

    await fs.rm(projectDir, { recursive: true, force: true });
  });

  it("pre-scans multi-dot configured Pages extensions", async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-layout-css-multi-dot-"));
    const appDir = path.join(projectDir, "app");
    const pagesDir = path.join(projectDir, "pages");
    const sourceDir = path.join(projectDir, "src");
    await fs.mkdir(path.join(appDir, "dashboard"), { recursive: true });
    await fs.mkdir(pagesDir, { recursive: true });
    await fs.mkdir(sourceDir, { recursive: true });

    const layout = path.join(appDir, "dashboard", "layout.tsx");
    const appHelper = path.join(appDir, "dashboard", "shared.tsx");
    const pagesRoute = path.join(pagesDir, "shared.page.tsx");
    const pagesHelper = path.join(sourceDir, "pages-helper.ts");
    const sharedClient = path.join(sourceDir, "shared-client.tsx");
    const stylesheet = path.join(sourceDir, "shared.css");
    await fs.writeFile(pagesRoute, `import "../src/pages-helper";\n`);
    await fs.writeFile(pagesHelper, `import "./shared-client";\n`);
    await fs.writeFile(sharedClient, `import "./shared.css";\n`);
    await fs.writeFile(stylesheet, `.shared { color: teal; }\n`);

    const resolutions = new Map([
      [`${pagesRoute}:../src/pages-helper`, pagesHelper],
      [`${pagesHelper}:./shared-client`, sharedClient],
      [`${sharedClient}:./shared.css`, stylesheet],
    ]);
    const plugin = createLayoutOwnedGlobalCssPlugin(
      () => appDir,
      () => pagesDir,
      { getPageExtensions: () => ["page.tsx"] },
    );
    const resolveId =
      typeof plugin.resolveId === "object" ? plugin.resolveId.handler : plugin.resolveId;
    const configResolved =
      typeof plugin.configResolved === "object"
        ? plugin.configResolved.handler
        : plugin.configResolved;
    await configResolved?.call(
      {} as never,
      {
        createResolver: () => async (source: string, importer?: string) =>
          importer ? resolutions.get(`${importer}:${source}`) : undefined,
      } as never,
    );

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

    await expect(
      resolveId!.call(createContext("client", stylesheet) as never, "./shared.css", sharedClient, {
        isEntry: false,
      }),
    ).resolves.toBeNull();

    await fs.rm(projectDir, { recursive: true, force: true });
  });

  it("pre-scans MDX-style imports for configured .md Pages routes", async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-layout-css-md-"));
    const appDir = path.join(projectDir, "app");
    const pagesDir = path.join(projectDir, "pages");
    const sourceDir = path.join(projectDir, "src");
    await fs.mkdir(path.join(appDir, "dashboard"), { recursive: true });
    await fs.mkdir(pagesDir, { recursive: true });
    await fs.mkdir(sourceDir, { recursive: true });

    const layout = path.join(appDir, "dashboard", "layout.tsx");
    const appHelper = path.join(appDir, "dashboard", "shared.tsx");
    const pagesRoute = path.join(pagesDir, "shared.md");
    const pagesHelper = path.join(sourceDir, "pages-helper.ts");
    const sharedClient = path.join(sourceDir, "shared-client.tsx");
    const stylesheet = path.join(sourceDir, "shared.css");
    await fs.writeFile(pagesRoute, `import "../src/pages-helper"\n\n# Shared\n`);
    await fs.writeFile(pagesHelper, `import "./shared-client";\n`);
    await fs.writeFile(sharedClient, `import "./shared.css";\n`);
    await fs.writeFile(stylesheet, `.shared { color: teal; }\n`);

    const resolutions = new Map([
      [`${pagesRoute}:../src/pages-helper`, pagesHelper],
      [`${pagesHelper}:./shared-client`, sharedClient],
      [`${sharedClient}:./shared.css`, stylesheet],
    ]);
    const plugin = createLayoutOwnedGlobalCssPlugin(
      () => appDir,
      () => pagesDir,
      { getPageExtensions: () => ["md", "tsx"] },
    );
    const resolveId =
      typeof plugin.resolveId === "object" ? plugin.resolveId.handler : plugin.resolveId;
    const configResolved =
      typeof plugin.configResolved === "object"
        ? plugin.configResolved.handler
        : plugin.configResolved;
    await configResolved?.call(
      {} as never,
      {
        createResolver: () => async (source: string, importer?: string) =>
          importer ? resolutions.get(`${importer}:${source}`) : undefined,
      } as never,
    );

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

    await expect(
      resolveId!.call(createContext("client", stylesheet) as never, "./shared.css", sharedClient, {
        isEntry: false,
      }),
    ).resolves.toBeNull();

    await fs.rm(projectDir, { recursive: true, force: true });
  });

  it("uses Pages SSR conditions when pre-scanning conditional exports", async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-layout-css-conditions-"));
    const appDir = path.join(projectDir, "app");
    const pagesDir = path.join(projectDir, "pages");
    const sourceDir = path.join(projectDir, "src");
    await fs.mkdir(path.join(appDir, "dashboard"), { recursive: true });
    await fs.mkdir(pagesDir, { recursive: true });
    await fs.mkdir(sourceDir, { recursive: true });

    const layout = path.join(appDir, "dashboard", "layout.tsx");
    const appHelper = path.join(appDir, "dashboard", "shared.tsx");
    const pagesRoute = path.join(pagesDir, "shared.tsx");
    const serverEntry = path.join(sourceDir, "conditional-server.ts");
    const clientEntry = path.join(sourceDir, "conditional-client.ts");
    const sharedClient = path.join(sourceDir, "shared-client.tsx");
    const stylesheet = path.join(sourceDir, "shared.css");
    await fs.writeFile(pagesRoute, `import "conditional-package";\n`);
    await fs.writeFile(serverEntry, `import "./shared-client";\n`);
    await fs.writeFile(clientEntry, `export {};\n`);
    await fs.writeFile(sharedClient, `import "./shared.css";\n`);
    await fs.writeFile(stylesheet, `.shared { color: teal; }\n`);

    const ssrFlags: boolean[] = [];
    const plugin = createLayoutOwnedGlobalCssPlugin(
      () => appDir,
      () => pagesDir,
    );
    const resolveId =
      typeof plugin.resolveId === "object" ? plugin.resolveId.handler : plugin.resolveId;
    const configResolved =
      typeof plugin.configResolved === "object"
        ? plugin.configResolved.handler
        : plugin.configResolved;
    await configResolved?.call(
      {} as never,
      {
        createResolver:
          () =>
          async (
            source: string,
            importer: string | undefined,
            _aliasOnly: boolean,
            ssr: boolean,
          ) => {
            ssrFlags.push(ssr);
            if (source === "conditional-package") return ssr ? serverEntry : clientEntry;
            if (source === "./shared-client") return sharedClient;
            if (source === "./shared.css") return stylesheet;
            return undefined;
          },
      } as never,
    );

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

    await expect(
      resolveId!.call(createContext("client", stylesheet) as never, "./shared.css", sharedClient, {
        isEntry: false,
      }),
    ).resolves.toBeNull();
    expect(ssrFlags.length).toBeGreaterThan(0);
    expect(ssrFlags.every(Boolean)).toBe(true);

    await fs.rm(projectDir, { recursive: true, force: true });
  });

  it("falls back conservatively when the Pages pre-scan exceeds its bound", async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-layout-css-bounded-"));
    const appDir = path.join(projectDir, "app");
    const pagesDir = path.join(projectDir, "pages");
    const sourceDir = path.join(projectDir, "src");
    await fs.mkdir(path.join(appDir, "dashboard"), { recursive: true });
    await fs.mkdir(pagesDir, { recursive: true });
    await fs.mkdir(sourceDir, { recursive: true });

    const layout = path.join(appDir, "dashboard", "layout.tsx");
    const appHelper = path.join(appDir, "dashboard", "shared.tsx");
    const pagesRoute = path.join(pagesDir, "shared.tsx");
    const chainOne = path.join(sourceDir, "one.ts");
    const chainTwo = path.join(sourceDir, "two.ts");
    const sharedClient = path.join(sourceDir, "shared-client.tsx");
    const stylesheet = path.join(sourceDir, "shared.css");
    await fs.writeFile(pagesRoute, `import "../src/one";\n`);
    await fs.writeFile(chainOne, `import "./two";\n`);
    await fs.writeFile(chainTwo, `import "./shared-client";\n`);
    await fs.writeFile(sharedClient, `import "./shared.css";\n`);
    await fs.writeFile(stylesheet, `.shared { color: teal; }\n`);

    const resolutions = new Map([
      [`${pagesRoute}:../src/one`, chainOne],
      [`${chainOne}:./two`, chainTwo],
      [`${chainTwo}:./shared-client`, sharedClient],
      [`${sharedClient}:./shared.css`, stylesheet],
    ]);
    const plugin = createLayoutOwnedGlobalCssPlugin(
      () => appDir,
      () => pagesDir,
      { maxPagesGraphModules: 2 },
    );
    const resolveId =
      typeof plugin.resolveId === "object" ? plugin.resolveId.handler : plugin.resolveId;
    const configResolved =
      typeof plugin.configResolved === "object"
        ? plugin.configResolved.handler
        : plugin.configResolved;
    await configResolved?.call(
      {} as never,
      {
        createResolver: () => async (source: string, importer?: string) =>
          importer ? resolutions.get(`${importer}:${source}`) : undefined,
      } as never,
    );

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

    await expect(
      resolveId!.call(createContext("client", stylesheet) as never, "./shared.css", sharedClient, {
        isEntry: false,
      }),
    ).resolves.toBeNull();

    await fs.rm(projectDir, { recursive: true, force: true });
  });
});
