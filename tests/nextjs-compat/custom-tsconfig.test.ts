/**
 * Ported from Next.js:
 * - test/e2e/tsconfig-path/index.test.ts
 * - test/e2e/typescript-custom-tsconfig/test/index.test.ts
 *
 * https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/tsconfig-path/index.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import fs from "node:fs/promises";
import path from "node:path";
import type { ViteDevServer } from "vite-plus";
import { buildAppFixture, buildPagesFixture, fetchHtml, startFixtureServer } from "../helpers.js";

const FIXTURE_DIR = path.resolve(import.meta.dirname, "../fixtures/custom-tsconfig");
const CUSTOM_TSCONFIG_PATH = path.join(FIXTURE_DIR, "web.tsconfig.json");

async function waitForHtml(baseUrl: string, expected: string[]): Promise<string> {
  const deadline = Date.now() + 10_000;
  let lastHtml = "";
  while (Date.now() < deadline) {
    ({ html: lastHtml } = await fetchHtml(baseUrl, `/?t=${Date.now()}`));
    if (expected.every((marker) => lastHtml.includes(marker))) return lastHtml;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${JSON.stringify(expected)} in HTML: ${lastHtml}`);
}

async function readBuildOutput(root: string): Promise<string> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const contents = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(root, entry.name);
      if (entry.isDirectory()) return readBuildOutput(entryPath);
      return fs.readFile(entryPath, "utf8").catch(() => "");
    }),
  );
  return contents.join("\n");
}

describe("Next.js compat: typescript.tsconfigPath dev", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(FIXTURE_DIR));
  }, 60_000);

  afterAll(async () => {
    await server.close();
  });

  it.each([
    ["App Router", "/", "app:"],
    ["Pages Router", "/page", "pages:"],
  ])("uses only the custom paths and baseUrl in %s", async (_router, route, marker) => {
    const { res, html } = await fetchHtml(baseUrl, route);
    expect(res.status).toBe(200);
    expect(html).toContain(marker);
    expect(html).toContain("bar123");
    expect(html).toContain("custom-base-url");
    expect(html).not.toContain("wrong-default");
  });

  it("uses only the custom paths and baseUrl in middleware", async () => {
    const res = await fetch(`${baseUrl}/middleware-result`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      value: "bar123",
      baseValue: "custom-base-url",
    });
  });

  it("applies custom paths and baseUrl edits without restarting dev", async () => {
    const originalConfig = await fs.readFile(CUSTOM_TSCONFIG_PATH, "utf8");
    const pagePath = path.join(FIXTURE_DIR, "app/page.tsx");
    const originalPage = await fs.readFile(pagePath, "utf8");
    const editedBaseUrlDir = path.join(FIXTURE_DIR, "edited-src");
    const editedPathFile = path.join(FIXTURE_DIR, "edited-bar.ts");
    await fs.mkdir(editedBaseUrlDir, { recursive: true });
    await fs.writeFile(
      path.join(editedBaseUrlDir, "base-value.ts"),
      'export default "edited-base";\n',
    );
    await fs.writeFile(editedPathFile, 'export default "edited-path";\n');

    try {
      await fs.writeFile(
        CUSTOM_TSCONFIG_PATH,
        JSON.stringify(
          {
            compilerOptions: {
              baseUrl: "./edited-src",
              paths: { foo: ["../edited-bar.ts"] },
              jsx: "react-jsx",
            },
            include: ["**/*.ts", "**/*.tsx"],
          },
          null,
          2,
        ) + "\n",
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      await fs.writeFile(pagePath, originalPage + "\n");

      const html = await waitForHtml(baseUrl, ["app:", "edited-path", "edited-base"]);
      expect(html).not.toContain("bar123");
      expect(html).not.toContain("custom-base-url");
    } finally {
      await fs.writeFile(CUSTOM_TSCONFIG_PATH, originalConfig);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await fs.writeFile(pagePath, originalPage);
      await waitForHtml(baseUrl, ["app:", "bar123", "custom-base-url"]);
      await fs.rm(editedBaseUrlDir, { recursive: true, force: true });
      await fs.rm(editedPathFile, { force: true });
    }
  });
});

describe("Next.js compat: typescript.tsconfigPath production", () => {
  let appOutput: string;
  let pagesOutput: string;

  beforeAll(async () => {
    const appBundlePath = await buildAppFixture(FIXTURE_DIR);
    const pagesBundlePath = await buildPagesFixture(FIXTURE_DIR);
    appOutput = await readBuildOutput(path.dirname(appBundlePath));
    pagesOutput = await readBuildOutput(path.dirname(pagesBundlePath));
  }, 120_000);

  it("builds App Router with the custom paths and baseUrl", () => {
    expect(appOutput).toContain("app:");
    expect(appOutput).toContain("bar123");
    expect(appOutput).toContain("custom-base-url");
    expect(appOutput).not.toContain("wrong-default");
  });

  it("builds Pages Router with the custom paths and baseUrl", () => {
    expect(pagesOutput).toContain("pages:");
    expect(pagesOutput).toContain("bar123");
    expect(pagesOutput).toContain("custom-base-url");
    expect(pagesOutput).not.toContain("wrong-default");
  });

  it("builds middleware with the custom paths and baseUrl", () => {
    expect(pagesOutput).toContain("middleware-result");
    expect(pagesOutput).toContain("bar123");
    expect(pagesOutput).toContain("custom-base-url");
    expect(pagesOutput).not.toContain("wrong-default");
  });

  afterAll(async () => {
    await fs.rm(path.join(FIXTURE_DIR, "dist"), { recursive: true, force: true });
  });
});
