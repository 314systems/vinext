import type { AddressInfo } from "node:net";
import path from "node:path";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";

const FIXTURE_DIR = path.resolve(import.meta.dirname, "fixtures/app-action-process");

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
    expect(response.headers.get("cache-control")).toBe(
      "no-cache, no-store, max-age=0, must-revalidate",
    );
  });
});
