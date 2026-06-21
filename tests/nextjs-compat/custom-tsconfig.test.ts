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
