import { spawn, type ChildProcess } from "node:child_process";
import { expect, test } from "@playwright/test";

const FIXTURE_DIR = `${process.cwd()}/tests/e2e/cloudflare-pages-router/image-fixture`;
const BASE_URL = "http://localhost:4195";
let server: ChildProcess;

function optimizerUrl(source: string): string {
  const url = new URL("/_next/image", BASE_URL);
  url.searchParams.set("url", source);
  url.searchParams.set("w", "32");
  url.searchParams.set("q", "75");
  return url.toString();
}

async function waitForServer(): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (server.exitCode !== null) throw new Error(`Pages Worker exited with ${server.exitCode}`);
    try {
      if ((await fetch(BASE_URL)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for Pages Worker image fixture");
}

test.describe("Cloudflare Pages Router image optimizer", () => {
  test.beforeAll(async () => {
    server = spawn(
      "created_node_modules=0; if ! test -e node_modules && ! test -L node_modules; then ln -s ../../../../examples/pages-router-cloudflare/node_modules node_modules; created_node_modules=1; fi; trap 'if test \"$created_node_modules\" = 1; then rm node_modules; fi' EXIT; npx vp build && npx wrangler dev --port 4195",
      { cwd: FIXTURE_DIR, shell: true, stdio: "inherit" },
    );
    await waitForServer();
  });

  test.afterAll(() => server.kill());

  test("validates, caches, conditions, and buffers a single internal source", async ({
    request,
  }) => {
    await request.get(`${BASE_URL}/image-test/reset`);
    const url = optimizerUrl("/image-test/source.png");
    const initial = await request.get(url);
    expect(initial.status()).toBe(200);
    expect(initial.headers()["content-type"]).toContain("image/png");
    expect(initial.headers()["cache-control"]).toBe("public, max-age=200, must-revalidate");
    const etag = initial.headers().etag;
    expect(etag).toBeTruthy();
    expect(await (await request.get(`${BASE_URL}/image-test/state`)).json()).toEqual({
      count: 1,
      method: "GET",
    });

    const conditional = await request.get(url, { headers: { "if-none-match": etag } });
    expect(conditional.status()).toBe(304);
    expect((await conditional.body()).byteLength).toBe(0);
    expect((await request.get(optimizerUrl("/image-test/source.png?spoof=1"))).status()).toBe(400);
    expect((await request.get(optimizerUrl("/image-test/source.png?oversize=1"))).status()).toBe(
      413,
    );

    await request.get(`${BASE_URL}/image-test/reset`);
    expect(
      (
        await request.fetch(optimizerUrl("/image-test/source.png"), {
          method: "POST",
        })
      ).status(),
    ).toBe(200);
    expect(await (await request.get(`${BASE_URL}/image-test/state`)).json()).toEqual({
      count: 1,
      method: "POST",
    });
  });
});
