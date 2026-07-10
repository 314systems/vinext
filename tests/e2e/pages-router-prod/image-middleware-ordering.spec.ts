import { expect, test } from "@playwright/test";

const BASE = "http://localhost:4175";
const PROTECTED_IMAGE = "/protected/private.png";

function optimizerUrl(source: string): string {
  const url = new URL("/_next/image", BASE);
  url.searchParams.set("url", source);
  url.searchParams.set("w", "32");
  url.searchParams.set("q", "75");
  return url.toString();
}

test.describe("Pages Router image request middleware ordering", () => {
  test("runs middleware when the optimizer fetches a local source image", async ({ request }) => {
    // Next.js dispatches local image source requests through its normal request handler.
    // Ported from the behavior in:
    // packages/next/src/server/next-server.ts (imageOptimizer / fetchInternalImage)
    // https://github.com/vercel/next.js/blob/canary/packages/next/src/server/next-server.ts
    const directResponse = await request.get(`${BASE}${PROTECTED_IMAGE}`);
    expect(directResponse.status()).toBe(401);

    const optimizedResponse = await request.get(optimizerUrl(PROTECTED_IMAGE), {
      maxRedirects: 0,
    });

    expect(optimizedResponse.status()).toBe(400);
    expect(optimizedResponse.headers()["location"]).toBeUndefined();
    expect(optimizedResponse.headers()["x-mw-pathname"]).toBeUndefined();
    expect(await optimizedResponse.text()).not.toContain("not-a-real-png");
  });

  test("sniffs bytes, bounds source bodies, and applies the configured cache policy", async ({
    request,
  }) => {
    const wrongType = await request.get(optimizerUrl("/image-test/source.png?wrong-type=1"));
    expect(wrongType.status()).toBe(200);
    expect(wrongType.headers()["content-type"]).toContain("image/png");
    expect(wrongType.headers()["cache-control"]).toBe("public, max-age=200, must-revalidate");
    expect(wrongType.headers()["content-disposition"]).toBe('inline; filename="source.png"');
    expect(wrongType.headers()["content-length"]).toBe(String((await wrongType.body()).byteLength));
    expect(wrongType.headers().etag).toBeTruthy();

    for (const source of ["/image-test/source.png?auth=1", "/image-test/source.png?spoof=1"]) {
      const invalid = await request.get(optimizerUrl(source));
      expect(invalid.status()).toBe(400);
      expect(await invalid.text()).toContain("isn't a valid image");
    }

    const oversized = await request.get(optimizerUrl("/image-test/source.png?oversize=1"));
    expect(oversized.status()).toBe(413);
  });

  test("returns a bodyless 304 and omits entity-only image headers", async ({ request }) => {
    const url = optimizerUrl("/image-test/source.png");
    const initial = await request.get(url);
    const etag = initial.headers().etag;
    expect(initial.status()).toBe(200);
    expect(etag).toBeTruthy();

    const conditional = await request.get(url, { headers: { "if-none-match": etag } });
    expect(conditional.status()).toBe(304);
    expect((await conditional.body()).byteLength).toBe(0);
    expect(conditional.headers().etag).toBe(etag);
    expect(conditional.headers()["cache-control"]).toBe("public, max-age=200, must-revalidate");
    expect(conditional.headers()["content-type"]).toBeUndefined();
    expect(conditional.headers()["content-disposition"]).toBeUndefined();
  });

  test("buffers one source dispatch on transform failure and preserves source methods", async ({
    request,
  }) => {
    await request.get(`${BASE}/image-test/reset`);
    const postResponse = await request.fetch(optimizerUrl("/image-test/source.png"), {
      method: "POST",
    });
    expect(postResponse.status()).toBe(200);
    const expectedContentLength = postResponse.headers()["content-length"];
    expect(expectedContentLength).toBeTruthy();
    let state = await (await request.get(`${BASE}/image-test/state`)).json();
    expect(state).toEqual({ count: 1, method: "POST" });

    await request.get(`${BASE}/image-test/reset`);
    const headResponse = await request.fetch(optimizerUrl("/image-test/source.png"), {
      method: "HEAD",
    });
    expect(headResponse.status()).toBe(200);
    expect((await headResponse.body()).byteLength).toBe(0);
    expect(headResponse.headers()["content-length"]).toBe(expectedContentLength);
    expect(headResponse.headers()["content-disposition"]).toBe('inline; filename="source.png"');
    state = await (await request.get(`${BASE}/image-test/state`)).json();
    expect(state).toEqual({ count: 1, method: "GET" });
  });

  test("bounds public files and classifies both imported-image output layouts", async ({
    request,
  }) => {
    expect((await request.get(optimizerUrl("/large-public.png"))).status()).toBe(413);
    for (const source of [
      "/static/media/static-image.bmp",
      "/_next/static/immutable/media/static-image.bmp",
    ]) {
      const response = await request.get(optimizerUrl(source));
      expect(response.status()).toBe(200);
      expect(response.headers()["cache-control"]).toBe("public, max-age=315360000, immutable");
      expect(response.headers()["content-disposition"]).toBe('inline; filename="static-image.bmp"');
      expect(response.headers()["content-length"]).toBe(String((await response.body()).byteLength));
    }
  });

  test("rejects nested image optimizer source paths before dispatch", async ({ request }) => {
    await request.get(`${BASE}/image-test/reset`);
    for (const source of ["/_next/image/again", "/docs/_next/image/again"]) {
      expect((await request.get(optimizerUrl(source))).status()).toBe(400);
    }
    expect(await (await request.get(`${BASE}/image-test/state`)).json()).toEqual({
      count: 0,
      method: "",
    });
  });
});
