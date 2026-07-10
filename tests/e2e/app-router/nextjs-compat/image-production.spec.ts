import { expect, test } from "@playwright/test";

function optimizerUrl(source: string): string {
  const url = new URL("/_next/image", "http://localhost:4191");
  url.searchParams.set("url", source);
  url.searchParams.set("w", "32");
  url.searchParams.set("q", "75");
  return url.toString();
}

// Ported from Next.js image optimizer behavior in:
// test/integration/image-optimizer/test/util.ts and
// packages/next/src/server/image-optimizer.ts (fetchInternalImage/sendResponse).
// https://github.com/vercel/next.js/blob/canary/test/integration/image-optimizer/test/util.ts
test.describe("App Router production image source parity", () => {
  test("validates source bytes, honors config, and serves conditional requests", async ({
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
      const invalid = await request.get(optimizerUrl(source));
      expect(invalid.status()).toBe(400);
      expect(await invalid.text()).toContain("isn't a valid image");
    }
    expect((await request.get(optimizerUrl("/image-test/source.png?oversize=1"))).status()).toBe(
      413,
    );
  });

  test("reuses one buffered source and preserves POST while mapping HEAD to GET", async ({
    request,
  }) => {
    await request.get("/image-test/reset");
    expect(
      (
        await request.fetch(optimizerUrl("/image-test/source.png"), {
          method: "POST",
        })
      ).status(),
    ).toBe(200);
    expect(await (await request.get("/image-test/state")).json()).toEqual({
      count: 1,
      method: "POST",
    });

    await request.get("/image-test/reset");
    const head = await request.fetch(optimizerUrl("/image-test/source.png"), { method: "HEAD" });
    expect(head.status()).toBe(200);
    expect((await head.body()).byteLength).toBe(0);
    expect(await (await request.get("/image-test/state")).json()).toEqual({
      count: 1,
      method: "GET",
    });
  });

  test("rejects nested optimizer source suffixes before middleware dispatch", async ({
    request,
  }) => {
    await request.get("/image-test/reset");
    for (const source of ["/_next/image/again", "/docs/_next/image/again"]) {
      expect((await request.get(optimizerUrl(source))).status()).toBe(400);
    }
    expect(await (await request.get("/image-test/state")).json()).toEqual({
      count: 0,
      method: "",
    });
  });
});
