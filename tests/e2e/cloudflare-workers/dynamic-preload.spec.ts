import { spawn, type ChildProcess } from "node:child_process";
import { expect, test } from "../fixtures";

const FIXTURE_DIR = `${process.cwd()}/tests/e2e/cloudflare-workers/fixture`;
const BASE_URL = "http://localhost:4192";

function optimizerUrl(source: string, quality = 75): string {
  const url = new URL("/_next/image", BASE_URL);
  url.searchParams.set("url", source);
  url.searchParams.set("w", "32");
  url.searchParams.set("q", String(quality));
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
    await request.get(`${BASE_URL}/image-test/reset`);
    const url = optimizerUrl("/image-test/source.png?wrong-type=1");
    const initial = await request.get(url);
    expect(initial.status()).toBe(200);
    expect(initial.headers()["content-type"]).toContain("image/png");
    expect(initial.headers()["cache-control"]).toBe("public, max-age=123, must-revalidate");
    expect(initial.headers()["content-disposition"]).toBe('attachment; filename="source.png"');
    expect(initial.headers()["x-nextjs-cache"]).toBe("MISS");
    expect(initial.headers()["content-length"]).toBe(String((await initial.body()).byteLength));
    const etag = initial.headers().etag;
    expect(etag).toBeTruthy();

    const conditional = await request.get(url, { headers: { "if-none-match": etag } });
    expect(conditional.status()).toBe(304);
    expect((await conditional.body()).byteLength).toBe(0);
    expect(conditional.headers()["content-type"]).toBeUndefined();
    expect(conditional.headers()["content-disposition"]).toBeUndefined();
    expect(await (await request.get(`${BASE_URL}/image-test/state`)).json()).toEqual({
      count: 1,
      method: "GET",
    });

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
    const postUrl = optimizerUrl("/image-test/source.png?method=post");
    const post = await request.fetch(postUrl, {
      method: "POST",
    });
    expect(post.status()).toBe(200);
    const expectedContentLength = post.headers()["content-length"];
    expect(expectedContentLength).toBeTruthy();
    expect(await (await request.get(`${BASE_URL}/image-test/state`)).json()).toEqual({
      count: 1,
      method: "POST",
    });
    const getAfterPost = await request.get(postUrl);
    expect(getAfterPost.headers()["x-nextjs-cache"]).toBe("MISS");
    expect(await (await request.get(`${BASE_URL}/image-test/state`)).json()).toEqual({
      count: 2,
      method: "GET",
    });

    await request.get(`${BASE_URL}/image-test/reset`);
    const head = await request.fetch(optimizerUrl("/image-test/source.png?method=head"), {
      method: "HEAD",
    });
    expect(head.status()).toBe(200);
    expect((await head.body()).byteLength).toBe(0);
    expect(head.headers()["content-length"]).toBe(expectedContentLength);
    expect(head.headers()["content-disposition"]).toBe('attachment; filename="source.png"');
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

  test("bounds public assets and classifies build-owned static media as immutable", async ({
    request,
  }) => {
    expect((await request.get(optimizerUrl("/large-public.png"))).status()).toBe(413);
    const mutable = await request.get(optimizerUrl("/static/media/static-image.bmp"));
    expect(mutable.status()).toBe(200);
    expect(mutable.headers()["cache-control"]).toBe("public, max-age=123, must-revalidate");

    const immutable = await request.get(optimizerUrl("/_next/static/media/static-image.bmp"));
    expect(immutable.status()).toBe(200);
    expect(immutable.headers()["cache-control"]).toBe("public, max-age=315360000, immutable");
    expect(immutable.headers()["content-disposition"]).toBe(
      'attachment; filename="static-image.bmp"',
    );

    const legacyImmutable = await request.get(
      optimizerUrl("/_next/static/immutable/media/static-image.bmp"),
    );
    expect(legacyImmutable.status()).toBe(200);
    expect(legacyImmutable.headers()["cache-control"]).toBe("public, max-age=315360000, immutable");

    for (const source of [
      "/%5Fnext/static/media/static-image.bmp",
      "/_next/static/%6dedia/static-image.bmp",
      "/_next/static/%69mmutable/media/static-image.bmp",
      "/_next/static/immutable/%6dedia/static-image.bmp",
    ]) {
      const encoded = await request.get(optimizerUrl(source));
      expect(encoded.status()).toBe(200);
      expect(encoded.headers()["cache-control"]).toBe("public, max-age=31536000, must-revalidate");
    }
  });

  test("negotiates and caches weighted image formats in a pure App Worker", async ({ request }) => {
    await request.get(`${BASE_URL}/image-test/reset`);
    const url = optimizerUrl("/image-test/source.png?format=weighted", 90);
    const avif = await request.get(url, {
      headers: { accept: "image/avif;q=0.9,image/webp;q=0.4" },
    });
    expect(avif.headers()["content-type"]).toContain("image/avif");
    expect(avif.headers()["x-nextjs-cache"]).toBe("MISS");
    expect(await avif.text()).toBe("format:image/avif");

    const webp = await request.get(url, {
      headers: { accept: "image/avif;q=0.2,image/webp;q=0.8" },
    });
    expect(webp.headers()["content-type"]).toContain("image/webp");
    expect(webp.headers()["x-nextjs-cache"]).toBe("MISS");
    expect(await webp.text()).toBe("format:image/webp");

    const cachedAvif = await request.get(url, { headers: { accept: "image/avif" } });
    expect(cachedAvif.headers()["x-nextjs-cache"]).toBe("HIT");
    const tied = await request.get(optimizerUrl("/image-test/source.png?format=tied", 90), {
      headers: { accept: "image/webp;q=0.8,image/avif;q=0.8" },
    });
    expect(tied.headers()["content-type"]).toContain("image/avif");
    expect(await tied.text()).toBe("format:image/avif");
    expect(await (await request.get(`${BASE_URL}/image-test/state`)).json()).toEqual({
      count: 3,
      method: "GET",
    });
  });

  // Ported from Next.js: test/integration/image-optimizer/test/util.ts
  // https://github.com/vercel/next.js/blob/canary/test/integration/image-optimizer/test/util.ts
  test("returns animated GIF, PNG, and WebP originals in a pure App Worker", async ({
    request,
  }) => {
    for (const [kind, contentType, signature] of [
      ["gif", "image/gif", [0x47, 0x49, 0x46]],
      ["png", "image/png", [0x89, 0x50, 0x4e, 0x47]],
      ["webp", "image/webp", [0x52, 0x49, 0x46, 0x46]],
    ] as const) {
      const response = await request.get(
        optimizerUrl(`/image-test/source.png?animated=${kind}`, 90),
      );
      expect(response.status()).toBe(200);
      expect(response.headers()["content-type"]).toContain(contentType);
      expect([...(await response.body()).subarray(0, signature.length)]).toEqual(signature);
    }
  });
});

test.describe("Cloudflare App Worker image passthrough without an optimizer", () => {
  let passthroughServer: ChildProcess;
  const passthroughBaseUrl = "http://localhost:4196";

  test.beforeAll(async () => {
    passthroughServer = spawn(
      "created_node_modules=0; if ! test -e node_modules && ! test -L node_modules; then ln -s ../../../../examples/app-router-cloudflare/node_modules node_modules; created_node_modules=1; fi; trap 'if test \"$created_node_modules\" = 1; then rm node_modules; fi' EXIT; npx vp build --config vite.no-optimizer.config.mjs && npx wrangler dev --config dist/server/wrangler.json --port 4196",
      { cwd: FIXTURE_DIR, shell: true, stdio: "inherit" },
    );
    for (let attempt = 0; attempt < 120; attempt++) {
      if (passthroughServer.exitCode !== null) {
        throw new Error(`passthrough App Worker exited with code ${passthroughServer.exitCode}`);
      }
      try {
        if ((await fetch(`${passthroughBaseUrl}/dynamic-preload`)).ok) return;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("Timed out waiting for passthrough App Worker");
  });

  test.afterAll(() => passthroughServer.kill());

  test("serves and caches the source image without a configured transform adapter", async ({
    request,
  }) => {
    const url = new URL("/_next/image", passthroughBaseUrl);
    url.searchParams.set("url", "/static/media/static-image.bmp");
    url.searchParams.set("w", "32");
    url.searchParams.set("q", "75");

    const first = await request.get(url.toString());
    expect(first.status()).toBe(200);
    expect(first.headers()["content-type"]).toContain("image/bmp");
    expect(first.headers()["content-disposition"]).toBe('attachment; filename="static-image.bmp"');
    expect(first.headers()["x-nextjs-cache"]).toBe("MISS");

    const second = await request.get(url.toString());
    expect(second.status()).toBe(200);
    expect(second.headers()["x-nextjs-cache"]).toBe("HIT");
    expect(await second.body()).toEqual(await first.body());
  });
});

// Ported from Next.js: test/integration/image-optimizer/test/index.test.ts
// https://github.com/vercel/next.js/blob/canary/test/integration/image-optimizer/test/index.test.ts
test.describe("Cloudflare App Worker with image optimization disabled", () => {
  let unoptimizedServer: ChildProcess;
  const unoptimizedBaseUrl = "http://localhost:4197";

  test.beforeAll(async () => {
    unoptimizedServer = spawn(
      "created_node_modules=0; if ! test -e node_modules && ! test -L node_modules; then ln -s ../../../../examples/app-router-cloudflare/node_modules node_modules; created_node_modules=1; fi; trap 'if test \"$created_node_modules\" = 1; then rm node_modules; fi' EXIT; TEST_IMAGE_UNOPTIMIZED=1 npx vp build --config vite.no-optimizer.config.mjs && npx wrangler dev --config dist/server/wrangler.json --port 4197",
      { cwd: FIXTURE_DIR, shell: true, stdio: "inherit" },
    );
    for (let attempt = 0; attempt < 120; attempt++) {
      if (unoptimizedServer.exitCode !== null) {
        throw new Error(`unoptimized App Worker exited with code ${unoptimizedServer.exitCode}`);
      }
      try {
        if ((await fetch(`${unoptimizedBaseUrl}/dynamic-preload`)).ok) return;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("Timed out waiting for unoptimized App Worker");
  });

  test.afterAll(() => unoptimizedServer.kill());

  test("returns 404 from the image optimization endpoint", async ({ request }) => {
    const url = new URL("/_next/image", unoptimizedBaseUrl);
    url.searchParams.set("url", "/static/media/static-image.bmp");
    url.searchParams.set("w", "32");
    url.searchParams.set("q", "75");

    expect((await request.get(url.toString())).status()).toBe(404);
  });
});
