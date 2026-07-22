import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getPluginApi } from "@vitejs/plugin-rsc";
import { createBuilder } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";

type RscHandler = (request: Request) => Promise<Response | string | null | undefined>;

describe("App route NEXT_RUNTIME production parity", () => {
  let root: string;
  let handler: RscHandler;
  let clientOutDir: string;
  let clientReferenceIds: string[];
  let serverReferenceIds: string[];
  let edgeRootLayoutEvaluationCount: number;

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
    await fs.mkdir(path.join(root, "app", "edge", "node_modules", "runtime-probe"), {
      recursive: true,
    });
    await fs.mkdir(path.join(root, "app", "edge-layout"), { recursive: true });
    await fs.mkdir(path.join(root, "app", "fake-edge"), { recursive: true });
    await fs.writeFile(
      path.join(root, "app", "shared", "root-runtime.ts"),
      `export const rootRuntime = process.env.NEXT_RUNTIME`,
    );
    await fs.writeFile(
      path.join(root, "app", "layout.tsx"),
      `
        import { rootRuntime } from "./shared/root-runtime"
        globalThis.__vinextRootLayoutEvaluations =
          (globalThis.__vinextRootLayoutEvaluations ?? 0) + 1
        export default function Layout({ children }) {
          return <html><body><span id="root-runtime">{rootRuntime}</span><span id="root-layout-evaluations">{globalThis.__vinextRootLayoutEvaluations}</span>{children}</body></html>
        }
      `,
    );
    await fs.writeFile(
      path.join(root, "app", "shared", "client.tsx"),
      `
        "use client"
        export const sharedClientMarker = "vinext-shared-runtime-client"
        export function SharedClient() { return <div>{sharedClientMarker}</div> }
      `,
    );
    await fs.writeFile(
      path.join(root, "app", "shared", "actions.ts"),
      `
        "use server"
        import { actionDependencyRuntime } from "./action-runtime"
        export async function sharedAction() { return actionDependencyRuntime }
      `,
    );
    await fs.writeFile(
      path.join(root, "app", "shared", "action-runtime.ts"),
      `export const actionDependencyRuntime = process.env.NEXT_RUNTIME`,
    );
    await fs.writeFile(
      path.join(root, "app", "shared", "page.tsx"),
      `
        import { SharedClient } from "./client"
        import { sharedAction } from "./actions"
        export default async function Page() {
          const actionRuntime = await sharedAction()
          return <><div id="runtime">{process.env.NEXT_RUNTIME}</div><div id="action-runtime">{actionRuntime}</div><SharedClient /><form action={sharedAction} /></>
        }
      `,
    );
    await fs.writeFile(
      path.join(root, "app", "nodejs", "page.tsx"),
      `export { default } from "../shared/page"`,
    );
    await fs.writeFile(
      path.join(root, "app", "edge", "layout.tsx"),
      `export default function EdgeLayout({ children }) { return <section>{children}</section> }`,
    );
    await fs.writeFile(
      path.join(root, "app", "edge", "page.tsx"),
      `
        export const runtime = \`edge\` satisfies "edge" | "nodejs"
        export { default } from "../shared/page"
        export { ClientRuntime } from "./client"
        import "runtime-probe"
      `,
    );
    await fs.writeFile(
      path.join(root, "app", "edge", "client.tsx"),
      `
        "use client"
        globalThis.__vinextClientRuntime = "client-runtime:" + process.env.NEXT_RUNTIME
        export function ClientRuntime() { return null }
      `,
    );
    await fs.writeFile(
      path.join(root, "app", "edge", "node_modules", "runtime-probe", "package.json"),
      `{"type":"module","exports":"./index.js"}`,
    );
    await fs.writeFile(
      path.join(root, "app", "edge", "node_modules", "runtime-probe", "index.js"),
      `
        if (process.env.NEXT_RUNTIME !== "edge") {
          throw new Error("dependency runtime: " + process.env.NEXT_RUNTIME)
        }
      `,
    );
    await fs.writeFile(
      path.join(root, "app", "edge-layout", "layout.tsx"),
      `export const runtime = "edge"; export { default } from "../layout"`,
    );
    await fs.writeFile(
      path.join(root, "app", "edge-layout", "route.ts"),
      `export function GET() { return new Response(process.env.NEXT_RUNTIME) }`,
    );
    await fs.writeFile(
      path.join(root, "app", "fake-edge", "page.tsx"),
      `
        // export const runtime = "edge"
        const example = 'export const runtime = "edge"'
        export default function Page() { return <div id="runtime">{process.env.NEXT_RUNTIME}</div> }
      `,
    );

    const rscOutDir = path.join(root, "dist", "server");
    clientOutDir = path.join(root, "dist", "client");
    const builder = await createBuilder({
      root,
      configFile: false,
      plugins: [
        vinext({
          appDir: root,
          rscOutDir,
          ssrOutDir: path.join(rscOutDir, "ssr"),
          clientOutDir,
        }),
        {
          name: "test:capture-rsc-client-reference-ids",
          buildEnd() {
            if (this.environment?.name !== "rsc") return;
            const pluginApi = getPluginApi(this.environment.config);
            clientReferenceIds = Object.keys(pluginApi?.manager.clientReferenceMetaMap ?? {});
            serverReferenceIds = Object.keys(pluginApi?.manager.serverReferenceMetaMap ?? {});
          },
        },
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
    const nodeHtml = await (nodeResponse as Response).text();
    expect(nodeHtml).toContain('id="runtime">nodejs');
    expect(nodeHtml).toContain('id="root-runtime">nodejs');
    expect(nodeHtml).toContain('id="action-runtime">nodejs');

    const beforeEdgeRequest = Number(
      (globalThis as { __vinextRootLayoutEvaluations?: number }).__vinextRootLayoutEvaluations ?? 0,
    );
    const edgeResponse = await handler(new Request("http://localhost/edge"));
    expect(edgeResponse).toBeInstanceOf(Response);
    const edgeHtml = await (edgeResponse as Response).text();
    expect(edgeHtml).toContain('id="runtime">edge');
    expect(edgeHtml).toContain('id="root-runtime">edge');
    expect(edgeHtml).toContain('id="action-runtime">edge');
    edgeRootLayoutEvaluationCount = Number(
      (globalThis as { __vinextRootLayoutEvaluations?: number }).__vinextRootLayoutEvaluations ?? 0,
    );
    expect(edgeRootLayoutEvaluationCount).toBe(beforeEdgeRequest + 1);

    const fakeEdgeResponse = await handler(new Request("http://localhost/fake-edge"));
    expect(fakeEdgeResponse).toBeInstanceOf(Response);
    expect(await (fakeEdgeResponse as Response).text()).toContain('id="runtime">nodejs');
  });

  it("keeps route handlers on node when only their layout is edge", async () => {
    const response = await handler(new Request("http://localhost/edge-layout"));
    expect(response).toBeInstanceOf(Response);
    expect(await (response as Response).text()).toBe("nodejs");
  });

  it("uses a distinct root layout module graph for edge routes", async () => {
    const beforeRequest = Number(
      (globalThis as { __vinextRootLayoutEvaluations?: number }).__vinextRootLayoutEvaluations ?? 0,
    );
    expect(beforeRequest).toBe(edgeRootLayoutEvaluationCount);
    const response = await handler(new Request("http://localhost/edge"));
    expect(response).toBeInstanceOf(Response);
    expect(await (response as Response).text()).toContain('id="root-runtime">edge');
    expect(
      Number(
        (globalThis as { __vinextRootLayoutEvaluations?: number }).__vinextRootLayoutEvaluations ??
          0,
      ),
    ).toBe(beforeRequest);
  });

  it("keeps client modules on the browser runtime value", async () => {
    const assets = await fs.readdir(clientOutDir, { recursive: true });
    const scripts = await Promise.all(
      assets
        .filter((asset) => asset.endsWith(".js"))
        .map((asset) => fs.readFile(path.join(clientOutDir, asset), "utf8")),
    );
    const clientBundle = scripts.join("\n");
    expect(clientBundle).toContain("client-runtime:");
    expect(clientBundle).not.toContain("client-runtime:edge");
    expect(clientBundle).not.toContain("client-runtime:nodejs");
  });

  it("emits one client reference for a boundary shared across route runtimes", async () => {
    const sharedClientReferences = clientReferenceIds.filter((id) =>
      id.includes("/app/shared/client.tsx"),
    );
    expect(sharedClientReferences).toHaveLength(1);
    expect(sharedClientReferences[0]).not.toContain("__vinext_app_runtime");

    const assets = await fs.readdir(clientOutDir, { recursive: true });
    const scripts = await Promise.all(
      assets
        .filter((asset) => asset.endsWith(".js"))
        .map((asset) => fs.readFile(path.join(clientOutDir, asset), "utf8")),
    );
    expect(
      scripts.filter((script) => script.includes("vinext-shared-runtime-client")),
    ).toHaveLength(1);
  });

  it("emits runtime-specific server references for an action shared across route runtimes", () => {
    const sharedServerReferences = serverReferenceIds.filter((id) =>
      id.includes("/app/shared/actions.ts"),
    );
    expect(sharedServerReferences).toHaveLength(2);
    expect(sharedServerReferences.some((id) => !id.includes("__vinext_app_runtime"))).toBe(true);
    expect(sharedServerReferences.some((id) => id.includes("__vinext_app_runtime=edge"))).toBe(
      true,
    );
  });
});
