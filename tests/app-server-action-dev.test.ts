import type { AddressInfo } from "node:net";
import path from "node:path";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";

const FIXTURE_DIR = path.resolve(import.meta.dirname, "fixtures/app-action-process");
const NO_ACTIONS_FIXTURE_DIR = path.resolve(import.meta.dirname, "fixtures/app-no-actions-process");

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
