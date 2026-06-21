import fs from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "../../fixtures";

type ProductionApp = {
  baseUrl: string;
  fixtureRoot: string;
  server: Server;
};

async function closeServer(server: Server): Promise<void> {
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeIdleConnections();
  server.closeAllConnections();
  await closed;
}

async function linkFixtureNodeModules(fixtureRoot: string): Promise<void> {
  const sourceNodeModules = path.resolve(process.cwd(), "node_modules");
  const targetNodeModules = path.join(fixtureRoot, "node_modules");
  await fs.mkdir(targetNodeModules, { recursive: true });

  for (const entry of await fs.readdir(sourceNodeModules, { withFileTypes: true })) {
    if (entry.name === ".vite" || entry.name === ".vite-temp" || entry.name === "vinext") continue;
    await fs.symlink(
      path.join(sourceNodeModules, entry.name),
      path.join(targetNodeModules, entry.name),
      entry.isDirectory() ? "junction" : "file",
    );
  }

  await fs.symlink(
    path.resolve(process.cwd(), "packages/vinext"),
    path.join(targetNodeModules, "vinext"),
    "junction",
  );
}

async function writeFixture(fixtureRoot: string): Promise<void> {
  const sourceRoot = path.resolve(
    process.cwd(),
    "tests/fixtures/app-basic/app/nextjs-compat/dynamic-css",
  );
  const appDir = path.join(fixtureRoot, "app");
  await fs.cp(sourceRoot, appDir, { recursive: true });
  await linkFixtureNodeModules(fixtureRoot);
  await fs.writeFile(
    path.join(fixtureRoot, "package.json"),
    `${JSON.stringify({ type: "module", dependencies: {} }, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(appDir, "layout.tsx"),
    `import type { ReactNode } from "react";
import "./layout.css";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html>
      <body>{children}</body>
    </html>
  );
}
`,
  );

  const vinextSource = path.resolve(process.cwd(), "packages/vinext/dist/index.js");
  await fs.writeFile(
    path.join(fixtureRoot, "vite.config.ts"),
    `import { defineConfig } from "vite";
import vinext from ${JSON.stringify(pathToFileURL(vinextSource).href)};

export default defineConfig({
  plugins: [vinext({ appDir: import.meta.dirname })],
});
`,
  );
}

async function buildAndServeFixture(): Promise<ProductionApp> {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-dynamic-css-"));
  await writeFixture(fixtureRoot);

  const { createBuilder } = await import("vite");
  const builder = await createBuilder({
    root: fixtureRoot,
    configFile: path.join(fixtureRoot, "vite.config.ts"),
    logLevel: "silent",
  });
  await builder.buildApp();

  const { runPrerender } = await import(
    pathToFileURL(path.resolve(process.cwd(), "packages/vinext/dist/build/run-prerender.js")).href
  );
  await runPrerender({ root: fixtureRoot });

  const { startProdServer } = await import(
    pathToFileURL(path.resolve(process.cwd(), "packages/vinext/dist/server/prod-server.js")).href
  );
  const started = await startProdServer({
    host: "127.0.0.1",
    port: 0,
    outDir: path.join(fixtureRoot, "dist"),
    noCompression: true,
  });

  return {
    baseUrl: `http://127.0.0.1:${started.port}`,
    fixtureRoot,
    server: started.server,
  };
}

test.setTimeout(90_000);

// Ported from Next.js: test/e2e/app-dir/next-dynamic-css/next-dynamic-css.test.ts
// https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/next-dynamic-css/next-dynamic-css.test.ts
test("preserves CSS order across layouts, client components, and next/dynamic", async ({
  page,
}) => {
  const app = await buildAndServeFixture();

  try {
    await page.goto(`${app.baseUrl}/page`, { waitUntil: "load" });

    const server = page.locator("#dynamic-css-server");
    await expect(server).toHaveText("Hello Server");
    await expect(server).toHaveCSS("background-color", "rgb(0, 128, 0)");
    await expect(server).toHaveCSS("color", "rgb(0, 0, 0)");

    const inner = page.locator("#dynamic-css-inner2");
    await expect(inner).toHaveText("Hello Inner 2");
    await expect(inner).toHaveCSS("background-color", "rgb(0, 128, 0)");
    await expect(inner).toHaveCSS("color", "rgb(0, 0, 0)");

    const component = page.locator("#dynamic-css-component");
    await expect(component).toHaveText("Hello Component");
    await expect(component).toHaveCSS("background-color", "rgb(0, 128, 0)");
    await expect(component).toHaveCSS("color", "rgb(0, 0, 0)");
    await expect(component).toHaveCSS("border-top-color", "rgb(255, 0, 0)");

    await expect(page.locator("#dynamic-css-global")).toHaveCSS(
      "background-color",
      "rgba(0, 0, 0, 0)",
    );
    await expect(page.locator("#dynamic-css-global")).toHaveCSS("color", "rgb(0, 0, 0)");
    await expect(page.locator("body")).toHaveCSS("background-color", "rgb(255, 255, 255)");
  } finally {
    await closeServer(app.server);
    await fs.rm(app.fixtureRoot, { recursive: true, force: true });
  }
});
