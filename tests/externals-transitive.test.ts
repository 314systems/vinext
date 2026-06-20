import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import path from "node:path";
import { createBuilder } from "vite";
import { afterAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import { startProdServer } from "../packages/vinext/src/server/prod-server.js";

const tempDirs: string[] = [];
const servers: Server[] = [];

function writeFixtureFile(root: string, filePath: string, content: string): void {
  const absolutePath = path.join(root, filePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content);
}

function writePackage(root: string, packagePath: string, version: string, source: string): void {
  writeFixtureFile(
    root,
    `${packagePath}/package.json`,
    JSON.stringify({ name: path.basename(packagePath), version, type: "module", main: "index.js" }),
  );
  writeFixtureFile(root, `${packagePath}/index.js`, source);
}

function linkPackage(root: string, packageName: string): void {
  fs.symlinkSync(
    path.join(root, "packages", packageName),
    path.join(root, "node_modules", packageName),
    "junction",
  );
}

async function createFixture(): Promise<string> {
  const root = await mkdtemp(path.join(import.meta.dirname, ".tmp-externals-transitive-"));
  tempDirs.push(root);

  writeFixtureFile(
    root,
    "package.json",
    JSON.stringify({ name: "vinext-externals-transitive", private: true, type: "module" }),
  );
  writeFixtureFile(
    root,
    "next.config.mjs",
    `export default { serverExternalPackages: ["shared-version", "nested-only"] };\n`,
  );
  writeFixtureFile(
    root,
    "app/layout.tsx",
    `export default function Layout({ children }: { children: React.ReactNode }) {
  return <html><body>{children}</body></html>;
}\n`,
  );
  writeFixtureFile(
    root,
    "app/page.tsx",
    `import depA from "dep-a";
import depB from "dep-b";
import rootVersion from "shared-version";

export default function Page() {
  return <p id="versions">{depA}, {depB}, root:{rootVersion}</p>;
}\n`,
  );

  writePackage(root, "node_modules/shared-version", "1.0.0", `export default "root";\n`);
  writePackage(
    root,
    "packages/dep-a",
    "1.0.0",
    `import version from "shared-version";
import nestedOnly from "nested-only";
export default "dep-a:" + version + ":" + nestedOnly;\n`,
  );
  writePackage(
    root,
    "packages/dep-a/node_modules/shared-version",
    "2.0.0",
    `export default "nested-a";\n`,
  );
  writePackage(
    root,
    "packages/dep-a/node_modules/nested-only",
    "1.0.0",
    `export default "nested-only";\n`,
  );
  writePackage(
    root,
    "packages/dep-b",
    "1.0.0",
    `import version from "shared-version";
import packageJson from "shared-version/package.json" with { type: "json" };
export default "dep-b:" + version + ":" + packageJson.version;\n`,
  );
  writePackage(
    root,
    "packages/dep-b/node_modules/shared-version",
    "3.0.0",
    `export default "nested-b";\n`,
  );
  linkPackage(root, "dep-a");
  linkPackage(root, "dep-b");

  return root;
}

afterAll(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    ),
  );
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("transitive server externals", () => {
  // Ported from Next.js: test/e2e/externals-transitive/externals-transitive.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/externals-transitive/externals-transitive.test.ts
  it("resolves external package versions relative to each importing dependency", async () => {
    const root = await createFixture();
    const builder = await createBuilder({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [
        vinext({
          appDir: root,
          rscOutDir: path.join(root, "dist/server"),
          ssrOutDir: path.join(root, "dist/server/ssr"),
          clientOutDir: path.join(root, "dist/client"),
        }),
      ],
    });
    await builder.buildApp();

    const started = await startProdServer({
      port: 0,
      host: "127.0.0.1",
      outDir: path.join(root, "dist"),
    });
    servers.push(started.server);
    const address = started.server.address();
    if (!address || typeof address === "string") throw new Error("Production server did not bind");

    const response = await fetch(`http://127.0.0.1:${address.port}/`);
    const html = await response.text();
    const normalizedHtml = html.replaceAll("<!-- -->", "");
    expect(response.status, html).toBe(200);
    expect(normalizedHtml).toContain("dep-a:nested-a:nested-only, dep-b:nested-b:3.0.0, root:root");
  }, 30_000);
});
