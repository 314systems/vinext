import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBuilder } from "vite";
import { afterAll, describe, expect, it } from "vitest";
import { runPrerender } from "../packages/vinext/src/build/run-prerender.js";
import vinext from "../packages/vinext/src/index.js";

const fixtureRoots: string[] = [];

async function writeFile(filePath: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, "utf8");
}

describe("App Router static useSearchParams", () => {
  afterAll(async () => {
    await Promise.all(fixtureRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it("renders the nearest Suspense fallback into prerendered HTML", async () => {
    // Ported from Next.js: test/e2e/app-dir/app-static/app-static.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-static/app-static.test.ts
    const workspaceRoot = path.resolve(import.meta.dirname, "..");
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-search-params-"));
    fixtureRoots.push(fixtureRoot);

    await writeFile(
      path.join(fixtureRoot, "package.json"),
      JSON.stringify({ name: "vinext-search-params", private: true, type: "module" }, null, 2),
    );
    await writeFile(
      path.join(fixtureRoot, "app", "layout.tsx"),
      `export default function Layout({ children }) {
  return <html><body>{children}</body></html>;
}`,
    );
    await writeFile(
      path.join(fixtureRoot, "app", "search-params.tsx"),
      `"use client";
import { useSearchParams } from "next/navigation";

export default function SearchParams() {
  return <p id="value">{useSearchParams().get("value") ?? "missing"}</p>;
}`,
    );
    await writeFile(
      path.join(fixtureRoot, "app", "page.tsx"),
      `import { Suspense } from "react";
import SearchParams from "./search-params";

export default function Page() {
  return <Suspense fallback={<p>search params suspense</p>}><SearchParams /></Suspense>;
}`,
    );
    await writeFile(
      path.join(fixtureRoot, "app", "force-static", "page.tsx"),
      `export const dynamic = "force-static";

import { Suspense } from "react";
import SearchParams from "../search-params";

export default function Page() {
  return <Suspense fallback={<p>search params suspense</p>}><SearchParams /></Suspense>;
}`,
    );
    await writeFile(
      path.join(fixtureRoot, "app", "dynamic-search-params", "page.tsx"),
      `import { Suspense } from "react";
import SearchParams from "../search-params";

export default async function Page({ searchParams }) {
  const value = (await searchParams).value;
  return <>
    <p id="server-value">{value}</p>
    <Suspense fallback={<p>search params suspense</p>}><SearchParams /></Suspense>
  </>;
}`,
    );
    await fs.symlink(
      path.join(workspaceRoot, "node_modules"),
      path.join(fixtureRoot, "node_modules"),
    );

    const builder = await createBuilder({
      root: fixtureRoot,
      configFile: false,
      plugins: [
        vinext({
          appDir: fixtureRoot,
          rscOutDir: path.join(fixtureRoot, "dist", "server"),
          ssrOutDir: path.join(fixtureRoot, "dist", "server", "ssr"),
          clientOutDir: path.join(fixtureRoot, "dist", "client"),
        }),
      ],
      logLevel: "silent",
    });
    await builder.buildApp();
    await runPrerender({
      root: fixtureRoot,
      rscBundlePath: path.join(fixtureRoot, "dist", "server", "index.js"),
      concurrency: 1,
    });

    const html = await fs.readFile(
      path.join(fixtureRoot, "dist", "server", "prerendered-routes", "index.html"),
      "utf8",
    );
    expect(html).toContain("<p>search params suspense</p>");
    expect(html).not.toContain('<p id="value">missing</p>');
    expect(html).toContain('"useLocationSearchParams":true');

    const forceStaticHtml = await fs.readFile(
      path.join(fixtureRoot, "dist", "server", "prerendered-routes", "force-static.html"),
      "utf8",
    );
    expect(forceStaticHtml).not.toContain("<p>search params suspense</p>");
    expect(forceStaticHtml).toContain('<p id="value">missing</p>');
    expect(forceStaticHtml).not.toContain('"useLocationSearchParams":true');

    // Consuming the Server Component searchParams prop makes this a dynamic
    // request render. Next.js therefore SSRs a nested client useSearchParams()
    // instead of applying prerender-only CSR bailout semantics.
    const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
    const { server } = await startProdServer({
      port: 0,
      outDir: path.join(fixtureRoot, "dist"),
      noCompression: true,
    });
    try {
      const address = server.address();
      expect(address && typeof address === "object").toBeTruthy();
      const port = typeof address === "object" && address ? address.port : 0;
      const response = await fetch(
        `http://127.0.0.1:${port}/dynamic-search-params?value=dynamic-value`,
      );
      expect(response.status).toBe(200);
      const dynamicHtml = await response.text();
      expect(dynamicHtml).toMatch(/<p id="server-value">(?:<!-- -->)?dynamic-value<\/p>/);
      expect(dynamicHtml).toMatch(/<p id="value">(?:<!-- -->)?dynamic-value<\/p>/);
      expect(dynamicHtml).not.toContain("<p>search params suspense</p>");
      expect(dynamicHtml).not.toContain("BAILOUT_TO_CLIENT_SIDE_RENDERING");
    } finally {
      server.close();
    }
  }, 60_000);
});
