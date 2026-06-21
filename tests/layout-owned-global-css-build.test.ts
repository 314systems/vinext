import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createBuilder } from "vite";
import { createLayoutOwnedGlobalCssPlugin } from "../packages/vinext/src/plugins/layout-owned-global-css.js";

const temporaryDirectories: string[] = [];
const cloudflarePagesExample = path.resolve(
  import.meta.dirname,
  "../examples/pages-router-cloudflare",
);

async function writeFile(filePath: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents);
}

async function createPagesFixture(): Promise<string> {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-layout-css-build-"));
  temporaryDirectories.push(projectDir);
  await writeFile(
    path.join(projectDir, "pages", "index.js"),
    `import "../src/shared.js";\nexport default function Home() {}\n`,
  );
  await writeFile(path.join(projectDir, "src", "shared.js"), `import "./global.css";\n`);
  await writeFile(path.join(projectDir, "src", "global.css"), `body { color: teal; }\n`);
  return projectDir;
}

async function buildPagesFixture(projectDir: string, serverEnvironmentName: string): Promise<void> {
  const pagesDir = path.join(projectDir, "pages");
  const input = path.join(pagesDir, "index.js");
  const plugin = createLayoutOwnedGlobalCssPlugin(
    () => path.join(projectDir, "app"),
    () => pagesDir,
  );
  const builder = await createBuilder({
    root: projectDir,
    configFile: false,
    logLevel: "error",
    plugins: [plugin],
    environments: {
      [serverEnvironmentName]: {
        consumer: "server",
        build: {
          ssr: true,
          outDir: `dist/${serverEnvironmentName}`,
          rolldownOptions: { input },
        },
      },
      client: {
        consumer: "client",
        build: {
          outDir: "dist/client",
          rolldownOptions: { input },
        },
      },
    },
  });

  await builder.build(builder.environments[serverEnvironmentName]);
  await builder.build(builder.environments.client);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("layout-owned global CSS production builds", () => {
  it("resolves Pages imports through the plain SSR build environment", async () => {
    const projectDir = await createPagesFixture();

    await expect(buildPagesFixture(projectDir, "ssr")).resolves.toBeUndefined();
  });

  it("resolves Pages imports through a Cloudflare-style named server environment", async () => {
    const projectDir = await createPagesFixture();

    await expect(buildPagesFixture(projectDir, "pages_router_cloudflare")).resolves.toBeUndefined();
  });

  it("completes the actual Cloudflare Pages Router production build", async () => {
    await fs.rm(path.join(cloudflarePagesExample, "dist"), { recursive: true, force: true });

    expect(() =>
      execFileSync("vp", ["build"], {
        cwd: cloudflarePagesExample,
        stdio: "pipe",
        timeout: 30_000,
      }),
    ).not.toThrow();

    await expect(
      fs.stat(path.join(cloudflarePagesExample, "dist", "client", ".vite", "manifest.json")),
    ).resolves.toBeDefined();
  });
});
