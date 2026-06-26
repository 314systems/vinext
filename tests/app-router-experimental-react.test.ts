// Ported from Next.js:
// test/e2e/app-dir/rsc-basic/rsc-basic-react-experimental.test.ts
// https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/rsc-basic/rsc-basic-react-experimental.test.ts

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { createBuilder, createServer, preview, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";

const FIXTURE_DIR = path.resolve(import.meta.dirname, "fixtures/app-experimental-react");
const DIST_DIR = path.join(FIXTURE_DIR, "dist");
const require = createRequire(import.meta.url);

describe("App Router experimental React channel", () => {
  let previewServer: Awaited<ReturnType<typeof preview>>;
  let devServer: ViteDevServer;
  let baseUrl = "";
  let devBaseUrl = "";
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
      devServer = await createServer({
        root: FIXTURE_DIR,
        configFile: false,
        plugins: [vinext({ appDir: FIXTURE_DIR })],
        server: { port: 0 },
        logLevel: "silent",
      });
      await devServer.listen();
    } catch (error) {
      fs.rmSync(DIST_DIR, { recursive: true, force: true });
      fs.rmSync(fixtureNodeModules, { recursive: true, force: true });
      throw error;
    }
    const address = previewServer.httpServer.address();
    baseUrl = address && typeof address === "object" ? `http://localhost:${address.port}` : "";
    const devAddress = devServer.httpServer?.address();
    devBaseUrl =
      devAddress && typeof devAddress === "object" ? `http://localhost:${devAddress.port}` : "";
  }, 120_000);

  afterAll(async () => {
    previewServer?.httpServer.close();
    await devServer?.close();
    fs.rmSync(DIST_DIR, { recursive: true, force: true });
    fs.rmSync(fixtureNodeModules, { recursive: true, force: true });
  });

  it("uses Next.js's vendored experimental React in RSC, SSR, and client bundles", async () => {
    const html = await fetch(baseUrl).then((response) => response.text());
    const versions = [
      ...html
        .replaceAll("<!-- -->", "")
        .matchAll(/(?:React|ReactDOM|ReactDOMServer)\.version=([^<]+)/g),
    ]
      .map((match) => match[1])
      .filter((version) => /^\d+\.\d+\.\d+/.test(version));

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

  it("uses the experimental React channel in the dev dependency optimizer", async () => {
    const response = await fetch(devBaseUrl);
    const html = await response.text();
    expect(response.status).toBe(200);
    const versions = [
      ...html
        .replaceAll("<!-- -->", "")
        .matchAll(/(?:React|ReactDOM|ReactDOMServer)\.version=([^<]+)/g),
    ]
      .map((match) => match[1])
      .filter((version) => /^\d+\.\d+\.\d+/.test(version));

    expect(versions.length).toBeGreaterThanOrEqual(5);
    expect(versions).toEqual(versions.map(() => expect.stringContaining("-experimental-")));
  });

  async function expectExternalReactRejection(external: true | string[]) {
    await expect(
      createServer({
        root: FIXTURE_DIR,
        configFile: false,
        plugins: vinext({ appDir: FIXTURE_DIR }),
        ssr: { external },
        logLevel: "silent",
      }),
    ).rejects.toThrow("Externalizing React through `ssr.external` or `serverExternalPackages`");
  }

  it("rejects ssr.external true because it bypasses experimental React", async () => {
    await expectExternalReactRejection(true);
  });

  it("rejects React entries in ssr.external", async () => {
    await expectExternalReactRejection(["react"]);
  });

  it("rejects React entries in serverExternalPackages", async () => {
    await expect(
      createServer({
        root: FIXTURE_DIR,
        configFile: false,
        plugins: vinext({
          appDir: FIXTURE_DIR,
          nextConfig: {
            experimental: { taint: true },
            serverExternalPackages: ["react-dom/server.edge"],
          },
        }),
        logLevel: "silent",
      }),
    ).rejects.toThrow("`serverExternalPackages` is incompatible");
  });
});
