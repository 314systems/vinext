import type { AddressInfo } from "node:net";
import { cp, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";

const FIXTURE_DIR = path.resolve(import.meta.dirname, "fixtures/app-action-process");
const NO_ACTIONS_FIXTURE_DIR = path.resolve(import.meta.dirname, "fixtures/app-no-actions-process");

async function retryUntil<T>(
  operation: () => Promise<T>,
  predicate: (value: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + 10_000;
  let value = await operation();
  while (!predicate(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    value = await operation();
  }
  return value;
}

describe("App Router dev progressive action errors", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    server = await createServer({
      root: FIXTURE_DIR,
      configFile: false,
      logLevel: "silent",
      plugins: [vinext({ appDir: FIXTURE_DIR })],
      server: { host: "127.0.0.1", port: 0 },
    });
    await server.listen();
    const address = server.httpServer!.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    expect((await fetch(baseUrl)).status).toBe(200);
  }, 30_000);

  afterAll(async () => {
    await server?.close();
  });

  // Ported from Next.js: test/e2e/app-dir/actions-unrecognized/actions-unrecognized.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/actions-unrecognized/actions-unrecognized.test.ts
  it("renders an HTML 500 for an invalid progressive action reference", async () => {
    const body = new FormData();
    body.set("$ACTION_ID_not-a-server-reference", "");
    const response = await fetch(baseUrl, {
      method: "POST",
      headers: { origin: baseUrl },
      body,
    });

    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("no-cache, must-revalidate");
  });

  it("preserves the development cache policy when an actions-enabled page has no marker", async () => {
    const body = new FormData();
    body.set("ordinary-field", "value");
    const response = await fetch(baseUrl, {
      method: "POST",
      headers: { origin: baseUrl },
      body,
    });

    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("no-cache, must-revalidate");
  });
});

describe("App Router dev build without server actions", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    server = await createServer({
      root: NO_ACTIONS_FIXTURE_DIR,
      configFile: false,
      logLevel: "silent",
      plugins: [vinext({ appDir: NO_ACTIONS_FIXTURE_DIR })],
      server: { host: "127.0.0.1", port: 0 },
    });
    await server.listen();
    const address = server.httpServer!.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 30_000);

  afterAll(async () => {
    await server?.close();
  });

  // Ported from Next.js: test/e2e/app-dir/no-server-actions/no-server-actions.test.ts
  // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/no-server-actions/no-server-actions.test.ts
  it("returns action-not-found with the development cache policy", async () => {
    const body = new FormData();
    body.set("ordinary-field", "value");
    const response = await fetch(baseUrl, { method: "POST", body });

    expect(response.status).toBe(404);
    expect(response.headers.get("x-nextjs-action-not-found")).toBe("1");
    expect(response.headers.get("cache-control")).toBe("no-cache, must-revalidate");
    expect(await response.text()).toBe("Server action not found.");
  });
});

describe("App Router dev server-action HMR", () => {
  let server: ViteDevServer;
  let baseUrl: string;
  let tempDir: string;
  let fixtureDir: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(import.meta.dirname, ".tmp-dev-action-hmr-"));
    fixtureDir = path.join(tempDir, "fixture");
    await cp(NO_ACTIONS_FIXTURE_DIR, fixtureDir, { recursive: true });
    server = await createServer({
      root: fixtureDir,
      configFile: false,
      logLevel: "silent",
      plugins: [vinext({ appDir: fixtureDir })],
      server: { host: "127.0.0.1", port: 0 },
    });
    await server.listen();
    const address = server.httpServer!.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 30_000);

  afterAll(async () => {
    await server?.close();
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it("tracks hot-added and hot-removed server actions", async () => {
    const markerlessPost = async () => {
      const body = new FormData();
      body.set("ordinary-field", "value");
      return fetch(baseUrl, { method: "POST", headers: { origin: baseUrl }, body });
    };

    // Prime both the RSC entry and the action-capability validation module while
    // the live plugin-rsc manifest is empty.
    const initial = await markerlessPost();
    expect(initial.status).toBe(404);
    expect(initial.headers.get("x-nextjs-action-not-found")).toBe("1");

    await writeFile(
      path.join(fixtureDir, "app/actions.ts"),
      `"use server";\nexport async function hotAction() { return "hot-action-ok"; }\n`,
    );
    await writeFile(
      path.join(fixtureDir, "app/page.tsx"),
      `import { hotAction } from "./actions";\nexport default function Page() { return <form action={hotAction}><button type="submit">Run hot action</button></form>; }\n`,
    );

    const addedHtml = await retryUntil(
      async () => (await fetch(baseUrl)).text(),
      (html) => html.includes("Run hot action") && html.includes("$ACTION_ID_"),
    );
    const marker = addedHtml.match(/name="(\$ACTION_ID_[^"]+)"/)?.[1];
    expect(marker).toBeDefined();

    const actionBody = new FormData();
    actionBody.set(marker!, "");
    const actionResponse = await retryUntil(
      () =>
        fetch(baseUrl, {
          method: "POST",
          headers: { origin: baseUrl },
          body: actionBody,
        }),
      (response) => response.status === 200,
    );
    expect(actionResponse.status).toBe(200);

    const enabledMarkerless = await markerlessPost();
    expect(enabledMarkerless.status).toBe(500);

    await writeFile(
      path.join(fixtureDir, "app/page.tsx"),
      `export default function Page() { return <h1>No server actions after HMR</h1>; }\n`,
    );
    await unlink(path.join(fixtureDir, "app/actions.ts"));

    const removedHtml = await retryUntil(
      async () => (await fetch(baseUrl)).text(),
      (html) => html.includes("No server actions after HMR") && !html.includes("$ACTION_ID_"),
    );
    expect(removedHtml).not.toContain("$ACTION_ID_");

    const removedMarkerless = await retryUntil(
      markerlessPost,
      (response) =>
        response.status === 404 && response.headers.get("x-nextjs-action-not-found") === "1",
    );
    expect(removedMarkerless.status).toBe(404);
    expect(removedMarkerless.headers.get("x-nextjs-action-not-found")).toBe("1");

    const staleActionBody = new FormData();
    staleActionBody.set(marker!, "");
    const staleAction = await fetch(baseUrl, {
      method: "POST",
      headers: { origin: baseUrl },
      body: staleActionBody,
    });
    expect(staleAction.status).toBe(404);
    expect(staleAction.headers.get("x-nextjs-action-not-found")).toBe("1");
    expect(await staleAction.text()).toBe("Server action not found.");

    // Neither transition may poison the dev process for subsequent requests.
    expect((await fetch(baseUrl)).status).toBe(200);
  }, 30_000);
});
