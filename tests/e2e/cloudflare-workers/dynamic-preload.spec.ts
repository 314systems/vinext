import { spawn, type ChildProcess } from "node:child_process";
import { expect, test } from "../fixtures";

const FIXTURE_DIR = `${process.cwd()}/tests/e2e/cloudflare-workers/fixture`;
const BASE_URL = "http://localhost:4192";

function optimizerUrl(source: string): string {
  const url = new URL("/_next/image", BASE_URL);
  url.searchParams.set("url", source);
  url.searchParams.set("w", "32");
  url.searchParams.set("q", "75");
  return url.toString();
}

let server: ChildProcess;

async function waitForServer(): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (server.exitCode !== null) {
      throw new Error(`pure App Worker exited with code ${server.exitCode}`);
    }
    try {
      const response = await fetch(`${BASE_URL}/dynamic-preload`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for pure App Worker");
}

test.describe("Cloudflare Workers dynamic preloads", () => {
  test.beforeAll(async () => {
    server = spawn(
      "created_node_modules=0; if ! test -e node_modules && ! test -L node_modules; then ln -s ../../../../examples/app-router-cloudflare/node_modules node_modules; created_node_modules=1; fi; trap 'if test \"$created_node_modules\" = 1; then rm node_modules; fi' EXIT; npx vp build && npx wrangler dev --config dist/server/wrangler.json --port 4192",
      {
        cwd: FIXTURE_DIR,
        shell: true,
        stdio: "inherit",
      },
    );
    await waitForServer();
  });

  test.afterAll(() => {
    server.kill();
  });

  test("preloads dynamic assets with the CSP nonce in a pure App Worker", async ({
    page,
    consoleErrors,
  }) => {
    const response = await page.goto(`${BASE_URL}/dynamic-preload`);
    expect(response?.headers()["content-security-policy"]).toContain(
      "script-src 'nonce-vinext-test-nonce' 'strict-dynamic';",
    );

    const dynamicStylesheet = page.locator('link[rel="stylesheet"][data-precedence="dynamic"]');
    await expect(dynamicStylesheet).toHaveCount(1);
    expect(await dynamicStylesheet.evaluate((element) => (element as HTMLLinkElement).nonce)).toBe(
      "vinext-test-nonce",
    );

    const dynamicScriptPreloads = page.locator(
      'link[rel="preload"][as="script"][fetchpriority="low"]',
    );
    await expect(dynamicScriptPreloads).not.toHaveCount(0);
    for (const preload of await dynamicScriptPreloads.all()) {
      expect(await preload.evaluate((element) => (element as HTMLLinkElement).nonce)).toBe(
        "vinext-test-nonce",
      );
    }

    await page.click('[data-testid="dynamic-count"]');
    await expect(page.locator('[data-testid="dynamic-count"]')).toHaveText("Dynamic count: 1");

    void consoleErrors;
  });

  test("matches production image validation, caching, and conditional responses", async ({
    request,
  }) => {
    const url = optimizerUrl("/image-test/source.png?wrong-type=1");
    const initial = await request.get(url);
    expect(initial.status()).toBe(200);
    expect(initial.headers()["content-type"]).toContain("image/png");
    expect(initial.headers()["cache-control"]).toBe("public, max-age=200, must-revalidate");
    const etag = initial.headers().etag;
    expect(etag).toBeTruthy();

    const conditional = await request.get(url, { headers: { "if-none-match": etag } });
    expect(conditional.status()).toBe(304);
    expect((await conditional.body()).byteLength).toBe(0);
    expect(conditional.headers()["content-type"]).toBeUndefined();
    expect(conditional.headers()["content-disposition"]).toBeUndefined();

    for (const source of ["/image-test/source.png?auth=1", "/image-test/source.png?spoof=1"]) {
      expect((await request.get(optimizerUrl(source))).status()).toBe(400);
    }
    expect((await request.get(optimizerUrl("/image-test/source.png?oversize=1"))).status()).toBe(
      413,
    );
  });

  test("uses one buffered Worker source dispatch and Next-compatible methods", async ({
    request,
  }) => {
    await request.get(`${BASE_URL}/image-test/reset`);
    const post = await request.fetch(optimizerUrl("/image-test/source.png"), { method: "POST" });
    expect(post.status()).toBe(200);
    expect(await (await request.get(`${BASE_URL}/image-test/state`)).json()).toEqual({
      count: 1,
      method: "POST",
    });

    await request.get(`${BASE_URL}/image-test/reset`);
    const head = await request.fetch(optimizerUrl("/image-test/source.png"), { method: "HEAD" });
    expect(head.status()).toBe(200);
    expect((await head.body()).byteLength).toBe(0);
    expect(await (await request.get(`${BASE_URL}/image-test/state`)).json()).toEqual({
      count: 1,
      method: "GET",
    });

    await request.get(`${BASE_URL}/image-test/reset`);
    for (const source of ["/_next/image/again", "/docs/_next/image/again"]) {
      expect((await request.get(optimizerUrl(source))).status()).toBe(400);
    }
    expect(await (await request.get(`${BASE_URL}/image-test/state`)).json()).toEqual({
      count: 0,
      method: "",
    });
  });
});
