import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBuilder } from "vite";
import { afterEach, expect, it } from "vitest";
import vinext from "../packages/vinext/src/index.js";

const roots: string[] = [];

function readJavaScript(dir: string): string {
  let source = "";
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) source += readJavaScript(entryPath);
    else if (/\.m?js$/.test(entry.name)) source += fs.readFileSync(entryPath, "utf8");
  }
  return source;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it("applies matching webpack loaders to App Router modules", async () => {
  // Ported from Next.js: test/e2e/app-dir/webpack-loader-set-environment-variable/
  // webpack-loader-set-environment-variable.test.ts
  // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/webpack-loader-set-environment-variable/webpack-loader-set-environment-variable.test.ts
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-webpack-loader-"));
  roots.push(root);
  const previousEnv = process.env.TEST_THIS_THING;
  delete process.env.TEST_THIS_THING;
  fs.symlinkSync(
    path.resolve(import.meta.dirname, "../node_modules"),
    path.join(root, "node_modules"),
  );
  fs.mkdirSync(path.join(root, "app"));
  fs.writeFileSync(
    path.join(root, "custom-loader.cjs"),
    `module.exports = () => { process.env.TEST_THIS_THING = "def"; return 'export default () => "The svg rendered"' }`,
  );
  fs.writeFileSync(
    path.join(root, "next.config.cjs"),
    `const { join } = require("node:path"); module.exports = { webpack(config) { config.module.rules.push({ test: /\\.svg$/, use: [join(__dirname, "custom-loader.cjs")] }); return config } }`,
  );
  fs.writeFileSync(
    path.join(root, "app", "layout.tsx"),
    `export default function Layout({ children }) { return <html><body>{children}</body></html> }`,
  );
  fs.writeFileSync(
    path.join(root, "app", "page.tsx"),
    `import Svg from "./next.svg"; export default function Page() { return <div id="the-svg"><Svg /></div> }`,
  );
  fs.writeFileSync(
    path.join(root, "app", "next.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg" />`,
  );

  try {
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

    expect(readJavaScript(path.join(root, "dist/server"))).toContain("The svg rendered");
    expect(process.env.TEST_THIS_THING).toBe("def");
  } finally {
    if (previousEnv === undefined) delete process.env.TEST_THIS_THING;
    else process.env.TEST_THIS_THING = previousEnv;
  }
});
