import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBuilder } from "vite";
import { describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";

// Ported from Next.js v16.2.6:
// test/e2e/app-dir/client-module-with-package-type/index.test.ts
// https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/client-module-with-package-type/index.test.ts

async function withTempDir<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vinext-client-package-type-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function writeFixtureFile(root: string, filePath: string, content: string): void {
  const absolutePath = path.join(root, filePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content);
}

function linkDependency(root: string, dependency: string): void {
  const source = path.resolve(import.meta.dirname, "../node_modules", dependency);
  const destination = path.join(root, "node_modules", dependency);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.symlinkSync(source, destination, "junction");
}

describe("App Router client module package type parity", () => {
  it("uses package exports and type for import and require client modules", async () => {
    await withTempDir(async (root) => {
      for (const dependency of ["react", "react-dom", "react-server-dom-webpack", "scheduler"]) {
        linkDependency(root, dependency);
      }

      writeFixtureFile(
        root,
        "package.json",
        JSON.stringify({ name: "client-package-type", private: true, type: "module" }, null, 2),
      );
      writeFixtureFile(
        root,
        "app/layout.tsx",
        `import type { ReactNode } from "react";

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html><body>{children}</body></html>;
}
`,
      );

      const routes = [
        ["import-cjs", 'import Component from "lib-cjs";', "lib-cjs"],
        ["require-cjs", 'const Component = require("lib-cjs");', "lib-cjs"],
        ["import-esm", 'import Component from "lib-esm";', "lib-esm"],
        ["require-esm", 'const Component = require("lib-esm");', "lib-esm"],
      ] as const;

      for (const [route, moduleStatement, label] of routes) {
        writeFixtureFile(
          root,
          `app/${route}/page.tsx`,
          `${moduleStatement}

export default function Page() {
  return <p>${label}: <Component /></p>;
}
`,
        );
      }

      writeFixtureFile(
        root,
        "node_modules/lib-cjs/package.json",
        JSON.stringify(
          {
            name: "lib-cjs",
            type: "commonjs",
            exports: { ".": { import: "./index.mjs", default: "./index.js" } },
          },
          null,
          2,
        ),
      );
      writeFixtureFile(
        root,
        "node_modules/lib-cjs/index.js",
        `'use client'; module.exports = () => 'cjs';`,
      );
      writeFixtureFile(
        root,
        "node_modules/lib-cjs/index.mjs",
        `'use client'; export default () => 'esm';`,
      );
      writeFixtureFile(
        root,
        "node_modules/lib-esm/package.json",
        JSON.stringify(
          {
            name: "lib-esm",
            type: "module",
            exports: { ".": { require: "./index.cjs", default: "./index.js" } },
          },
          null,
          2,
        ),
      );
      writeFixtureFile(
        root,
        "node_modules/lib-esm/index.js",
        `'use client'; export default () => 'esm';`,
      );
      writeFixtureFile(
        root,
        "node_modules/lib-esm/index.cjs",
        `'use client'; module.exports = () => 'cjs';`,
      );

      const outDir = path.join(root, "dist");
      const builder = await createBuilder({
        root,
        configFile: false,
        plugins: [vinext({ appDir: root })],
        logLevel: "silent",
      });
      await builder.buildApp();

      const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
      const { server } = await startProdServer({ port: 0, outDir, noCompression: true });

      try {
        const address = server.address();
        expect(address && typeof address === "object").toBe(true);
        const baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

        for (const [route, expected] of [
          ["import-cjs", "lib-cjs: esm"],
          ["require-cjs", "lib-cjs: cjs"],
          ["import-esm", "lib-esm: esm"],
          ["require-esm", "lib-esm: cjs"],
        ] as const) {
          const response = await fetch(`${baseUrl}/${route}`);
          const html = await response.text();
          expect(response.status, `${route}: ${html}`).toBe(200);
          const text = html
            .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "")
            .replace(/<!--.*?-->/g, "")
            .replace(/<[^>]+>/g, "")
            .replace(/\s+/g, " ")
            .trim();
          expect(text).toContain(expected);
        }
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    });
  }, 90_000);
});
