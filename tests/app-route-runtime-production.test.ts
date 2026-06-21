import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createBuilder } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";

type RscHandler = (request: Request) => Promise<Response | string | null | undefined>;

describe("App route NEXT_RUNTIME production parity", () => {
  let root: string;
  let handler: RscHandler;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-app-route-runtime-prod-"));
    await fs.writeFile(path.join(root, "package.json"), `{"type":"module"}`);
    await fs.symlink(
      path.resolve(import.meta.dirname, "../node_modules"),
      path.join(root, "node_modules"),
      "junction",
    );
    await fs.mkdir(path.join(root, "app", "shared"), { recursive: true });
    await fs.mkdir(path.join(root, "app", "nodejs"), { recursive: true });
    await fs.mkdir(path.join(root, "app", "edge"), { recursive: true });
    await fs.writeFile(
      path.join(root, "app", "layout.tsx"),
      `export default function Layout({ children }) { return <html><body>{children}</body></html> }`,
    );
    await fs.writeFile(
      path.join(root, "app", "shared", "page.tsx"),
      `export default function Page() { return <div id="runtime">{process.env.NEXT_RUNTIME}</div> }`,
    );
    await fs.writeFile(
      path.join(root, "app", "nodejs", "page.tsx"),
      `export { default } from "../shared/page"`,
    );
    await fs.writeFile(
      path.join(root, "app", "edge", "layout.tsx"),
      `export const runtime = "edge"; export { default } from "../layout"`,
    );
    await fs.writeFile(
      path.join(root, "app", "edge", "page.tsx"),
      `export { default } from "../shared/page"`,
    );

    const rscOutDir = path.join(root, "dist", "server");
    const builder = await createBuilder({
      root,
      configFile: false,
      plugins: [
        vinext({
          appDir: root,
          rscOutDir,
          ssrOutDir: path.join(rscOutDir, "ssr"),
          clientOutDir: path.join(root, "dist", "client"),
        }),
      ],
      logLevel: "silent",
    });
    await builder.buildApp();
    const built = (await import(pathToFileURL(path.join(rscOutDir, "index.js")).href)) as {
      default: RscHandler;
    };
    handler = built.default;
  }, 120_000);

  afterAll(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it("stamps shared modules with the matched route runtime", async () => {
    const nodeResponse = await handler(new Request("http://localhost/nodejs"));
    expect(nodeResponse).toBeInstanceOf(Response);
    expect(await (nodeResponse as Response).text()).toContain('id="runtime">nodejs');

    const edgeResponse = await handler(new Request("http://localhost/edge"));
    expect(edgeResponse).toBeInstanceOf(Response);
    expect(await (edgeResponse as Response).text()).toContain('id="runtime">edge');
  });
});
