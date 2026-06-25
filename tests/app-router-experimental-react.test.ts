// Ported from Next.js:
// test/e2e/app-dir/rsc-basic/rsc-basic-react-experimental.test.ts
// https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/rsc-basic/rsc-basic-react-experimental.test.ts

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { createBuilder, preview } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";

const FIXTURE_DIR = path.resolve(import.meta.dirname, "fixtures/app-experimental-react");
const DIST_DIR = path.join(FIXTURE_DIR, "dist");
const require = createRequire(import.meta.url);

describe("App Router experimental React channel", () => {
  let previewServer: Awaited<ReturnType<typeof preview>>;
  let baseUrl = "";
  const fixtureNodeModules = path.join(FIXTURE_DIR, "node_modules");

  beforeAll(async () => {
    const nextPackageDir = process.env.VINEXT_TEST_NEXT_PACKAGE_DIR
      ? path.resolve(process.env.VINEXT_TEST_NEXT_PACKAGE_DIR)
      : path.dirname(require.resolve("next/package.json"));
    try {
      fs.mkdirSync(fixtureNodeModules, { recursive: true });
      fs.symlinkSync(nextPackageDir, path.join(fixtureNodeModules, "next"), "junction");
      const builder = await createBuilder({
        root: FIXTURE_DIR,
        configFile: false,
        plugins: [vinext({ appDir: FIXTURE_DIR })],
        logLevel: "silent",
      });
      await builder.buildApp();

      previewServer = await preview({
        root: FIXTURE_DIR,
        configFile: false,
        plugins: [vinext({ appDir: FIXTURE_DIR })],
        preview: { port: 0 },
        logLevel: "silent",
      });
    } catch (error) {
      fs.rmSync(DIST_DIR, { recursive: true, force: true });
      fs.rmSync(fixtureNodeModules, { recursive: true, force: true });
      throw error;
    }
    const address = previewServer.httpServer.address();
    baseUrl = address && typeof address === "object" ? `http://localhost:${address.port}` : "";
  }, 120_000);

  afterAll(() => {
    previewServer?.httpServer.close();
    fs.rmSync(DIST_DIR, { recursive: true, force: true });
    fs.rmSync(fixtureNodeModules, { recursive: true, force: true });
  });

  it("uses Next.js's vendored experimental React in RSC, SSR, and client bundles", async () => {
    const html = await fetch(baseUrl).then((response) => response.text());
    const versions = [
      ...html
        .replaceAll("<!-- -->", "")
        .matchAll(/(?:React|ReactDOM|ReactDOMServer)\.version=([^<]+)/g),
    ].map((match) => match[1]);

    expect(versions.length).toBeGreaterThanOrEqual(5);
    expect(versions.every((version) => version.includes("-experimental-"))).toBe(true);

    const clientJavaScript = fs
      .readdirSync(path.join(DIST_DIR, "client", "_next", "static", "chunks"))
      .filter((file) => file.endsWith(".js"))
      .map((file) =>
        fs.readFileSync(path.join(DIST_DIR, "client", "_next", "static", "chunks", file), "utf8"),
      )
      .join("\n");
    expect(clientJavaScript).toContain("-experimental-");
  });
});
