import { expect, test } from "@playwright/test";

const BASE = "http://localhost:4175";
const PROTECTED_IMAGE = "/protected/private.png";

test.describe("Pages Router image request middleware ordering", () => {
  test("runs middleware when the optimizer fetches a local source image", async ({ request }) => {
    // Next.js dispatches local image source requests through its normal request handler.
    // Ported from the behavior in:
    // packages/next/src/server/next-server.ts (imageOptimizer / fetchInternalImage)
    // https://github.com/vercel/next.js/blob/canary/packages/next/src/server/next-server.ts
    const directResponse = await request.get(`${BASE}${PROTECTED_IMAGE}`);
    expect(directResponse.status()).toBe(401);

    const optimizerUrl = new URL("/_next/image", BASE);
    optimizerUrl.searchParams.set("url", PROTECTED_IMAGE);
    optimizerUrl.searchParams.set("w", "32");
    optimizerUrl.searchParams.set("q", "75");

    const optimizedResponse = await request.get(optimizerUrl.toString(), {
      maxRedirects: 0,
    });

    expect(optimizedResponse.status()).toBe(404);
    expect(optimizedResponse.headers()["location"]).toBeUndefined();
    expect(optimizedResponse.headers()["x-mw-pathname"]).toBeUndefined();
    expect(await optimizedResponse.text()).toBe("Image not found");
  });

  test("does not expose source middleware headers on a successful image response", async ({
    request,
  }) => {
    const optimizerUrl = new URL("/_next/image", BASE);
    optimizerUrl.searchParams.set("url", "/images/middleware-visible.png");
    optimizerUrl.searchParams.set("w", "32");
    optimizerUrl.searchParams.set("q", "75");

    const response = await request.get(optimizerUrl.toString());

    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("image/png");
    expect(response.headers()["x-custom-middleware"]).toBeUndefined();
    expect(response.headers()["x-mw-pathname"]).toBeUndefined();
  });

  test("allows middleware to resolve an extensionless source as an image", async ({ request }) => {
    const optimizerUrl = new URL("/_next/image", BASE);
    optimizerUrl.searchParams.set("url", "/middleware-image-alias");
    optimizerUrl.searchParams.set("w", "32");
    optimizerUrl.searchParams.set("q", "75");

    const response = await request.get(optimizerUrl.toString());

    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("image/png");
  });
});
