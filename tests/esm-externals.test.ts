/**
 * Ported from Next.js: test/e2e/esm-externals/esm-externals.test.ts
 * https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/esm-externals/esm-externals.test.ts
 */
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { build, createBuilder } from "vite";
import vinext from "../packages/vinext/src/index.js";
import { startProdServer } from "../packages/vinext/src/server/prod-server.js";

const WORKSPACE_NODE_MODULES = path.resolve(import.meta.dirname, "../node_modules");
const fixtureRoots: string[] = [];

afterAll(async () => {
  await Promise.all(fixtureRoots.map((root) => fsp.rm(root, { recursive: true, force: true })));
});

async function writeFile(root: string, name: string, contents: string): Promise<void> {
  const file = path.join(root, name);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, contents, "utf8");
}

async function linkDependency(root: string, name: string): Promise<void> {
  const destination = path.join(root, "node_modules", name);
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  await fsp.symlink(path.join(WORKSPACE_NODE_MODULES, name), destination, "junction");
}

async function writePackage(
  root: string,
  name: string,
  manifest: object,
  files: Record<string, string>,
): Promise<void> {
  await writeFile(root, `node_modules/${name}/package.json`, JSON.stringify({ name, ...manifest }));
  await Promise.all(
    Object.entries(files).map(([file, contents]) =>
      writeFile(root, `node_modules/${name}/${file}`, contents),
    ),
  );
}

async function createFixture(
  router: "pages" | "app",
  options: { transpilePackages?: string[] } = {},
): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `vinext-esm-externals-${router}-`));
  fixtureRoots.push(root);
  await writeFile(root, "package.json", JSON.stringify({ type: "module" }));
  await linkDependency(root, "react");
  await linkDependency(root, "react-dom");
  await linkDependency(root, "styled-jsx");

  for (const prefix of router === "app" ? ["app-"] : [""]) {
    await writePackage(
      root,
      `${prefix}esm-package1`,
      {
        exports: {
          "./entry": {
            browser: "./browser.mjs",
            import: "./correct.mjs",
            require: "./wrong.js",
          },
        },
      },
      {
        "browser.mjs": `export default "World"; if (typeof window === "undefined") throw new Error("browser export used on server");`,
        "correct.mjs": `export default "World"; if (Math.random() < 0) import("fail");`,
        "wrong.js": `module.exports = "Wrong";`,
      },
    );
    await writePackage(
      root,
      `${prefix}esm-package2`,
      {
        type: "module",
        exports: {
          "./entry": {
            browser: "./browser.mjs",
            import: "./correct.js",
            require: "./wrong.cjs",
          },
        },
      },
      {
        "browser.mjs": `export default "World"; if (typeof window === "undefined") throw new Error("browser export used on server");`,
        "correct.js": `await 1; export default "World"; if (Math.random() < 0) import("fail");`,
        "wrong.cjs": `module.exports = "Wrong";`,
      },
    );
  }

  const cjsName = router === "app" ? "app-cjs-esm-package" : "invalid-esm-package";
  await writePackage(
    root,
    cjsName,
    {
      exports: {
        "./entry": {
          browser: "./browser.js",
          import: "./correct.js",
          require: "./alternative.js",
        },
      },
    },
    {
      "browser.js": `export default "World"; if (typeof window === "undefined") throw new Error("browser export used on server");`,
      "correct.js":
        router === "app"
          ? `module.exports = "World"; if (Math.random() < 0) require("fail");`
          : `export default "World";`,
      "alternative.js": `module.exports = "Alternative";`,
    },
  );

  if (router === "pages") {
    await writePackage(
      root,
      "transitive-esm-package",
      {
        type: "module",
        exports: { ".": "./index.js" },
      },
      {
        "index.js": `export default "Transitive"; if (Math.random() < 0) import("fail");`,
      },
    );
    await writeFile(
      root,
      "node_modules/invalid-esm-package/alternative.js",
      `module.exports = require("transitive-esm-package").default === "Transitive" ? "Alternative" : "Wrong";`,
    );
  }

  const imports =
    router === "app"
      ? `import World1 from "app-esm-package1/entry";
import World2 from "app-esm-package2/entry";
import World3 from "app-cjs-esm-package/entry";`
      : `import World1 from "esm-package1/entry";
import World2 from "esm-package2/entry";
import World3 from "invalid-esm-package/entry";`;

  if (router === "pages") {
    if (options.transpilePackages) {
      await writeFile(
        root,
        "next.config.mjs",
        `export default { transpilePackages: ${JSON.stringify(options.transpilePackages)} };\n`,
      );
    }
    await writeFile(
      root,
      "pages/index.tsx",
      `${imports}
export function getServerSideProps() { return { props: { server: [World1, World2, World3].join("+") } }; }
export default function Page({ server }: { server: string }) {
  return <p>{server}</p>;
}
`,
    );
  } else {
    await writeFile(
      root,
      "next.config.mjs",
      `export default { serverExternalPackages: ["app-esm-package1", "app-esm-package2", "app-cjs-esm-package"] };\n`,
    );
    await writeFile(
      root,
      "app/layout.tsx",
      `export default function Layout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }\n`,
    );
    await writeFile(
      root,
      "app/page.tsx",
      `${imports}
export default function Page() { return <p>{[World1, World2, World3].join("+")}</p>; }
`,
    );
  }
  return root;
}

async function buildFixture(root: string, router: "pages" | "app"): Promise<string> {
  const outDir = path.join(root, "dist");
  if (router === "pages") {
    await build({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [vinext({ disableAppRouter: true })],
      build: {
        outDir: path.join(outDir, "server"),
        ssr: "virtual:vinext-server-entry",
        rolldownOptions: { output: { entryFileNames: "entry.js" } },
      },
    });
    await build({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [vinext({ disableAppRouter: true })],
      build: {
        outDir: path.join(outDir, "client"),
        manifest: true,
        ssrManifest: true,
        rolldownOptions: { input: "virtual:vinext-client-entry" },
      },
    });
  } else {
    const builder = await createBuilder({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [
        vinext({
          appDir: root,
          rscOutDir: path.join(outDir, "server"),
          ssrOutDir: path.join(outDir, "server", "ssr"),
          clientOutDir: path.join(outDir, "client"),
        }),
      ],
    });
    await builder.buildApp();
  }
  return outDir;
}

function unwrapStartedProdServer(
  result: import("node:http").Server | { server: import("node:http").Server },
): import("node:http").Server {
  return "server" in result ? result.server : result;
}

async function renderFixture(router: "pages" | "app"): Promise<{ html: string; root: string }> {
  const root = await createFixture(router);
  const outDir = await buildFixture(root, router);
  const server = unwrapStartedProdServer(
    await startProdServer({ host: "127.0.0.1", port: 0, outDir }),
  );
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing server address");
    const response = await fetch(`http://127.0.0.1:${address.port}/`);
    expect(response.status).toBe(200);
    return { html: await response.text(), root };
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe("ESM external package parity", () => {
  it("resolves Pages packages using import semantics while bundling invalid ESM", async () => {
    const { html } = await renderFixture("pages");
    expect(html).toContain("World+World+Alternative");
    expect(html).not.toContain("Wrong");
  }, 120_000);

  it("loads App serverExternalPackages through Node ESM semantics", async () => {
    const { html } = await renderFixture("app");
    expect(html).toContain("World+World+World");
    expect(html).not.toContain("Wrong");
    expect(html).not.toContain("Alternative");
  }, 120_000);

  it("keeps transpilePackages bundled instead of externalizing native ESM", async () => {
    const root = await createFixture("pages", { transpilePackages: ["esm-package1"] });
    await expect(buildFixture(root, "pages")).rejects.toThrow(/failed to resolve import "fail"/i);
  }, 120_000);
});
