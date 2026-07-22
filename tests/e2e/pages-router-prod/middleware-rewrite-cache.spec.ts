import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4175";

test.describe("Pages middleware rewrite cache parity", () => {
  test("query-invariant ISR rewrite preserves shared caching", async ({ request }) => {
    const response = await request.get(`${BASE}/mw-rewrite-isr`);

    expect(response.status()).toBe(200);
    expect(await response.text()).toContain("Hello from ISR");
    expect(response.headers()["cache-control"]).toContain("s-maxage=1");
  });

  test("query-invariant static GSP rewrite does not force no-cache", async ({ request }) => {
    const htmlResponse = await request.get(`${BASE}/mw-rewrite-static-gsp`);
    expect(htmlResponse.status()).toBe(200);
    expect(await htmlResponse.text()).toContain("Hello from static GSP");
    expect(htmlResponse.headers()["cache-control"]).toBeUndefined();

    const dataResponse = await request.get(
      `${BASE}/_next/data/test-build-id/mw-rewrite-static-gsp.json`,
    );
    expect(dataResponse.status()).toBe(200);
    expect(await dataResponse.json()).toMatchObject({
      pageProps: { message: "Hello from static GSP" },
    });
    expect(dataResponse.headers()["cache-control"]).toBeUndefined();
  });
});
