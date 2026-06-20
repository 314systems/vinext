import { test, expect, type Page } from "@playwright/test";

async function expectHydratedQuery(
  page: Page,
  url: string,
  expectedParams: unknown,
  expectedInitialQuery: unknown,
  expectedQuery: unknown,
) {
  const hydrationErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && /hydration|did not match/i.test(message.text())) {
      hydrationErrors.push(message.text());
    }
  });

  await page.goto(url);
  await expect
    .poll(async () => JSON.parse(await page.locator("#params").innerText()))
    .toEqual(expectedParams);
  await expect
    .poll(async () => JSON.parse(await page.locator("#query").innerText()))
    .toEqual(expectedQuery);
  expect(await page.evaluate(() => (window as any).__NEXT_DATA__.query)).toEqual(
    expectedInitialQuery,
  );
  expect(hydrationErrors).toEqual([]);
}

test.describe("Pages prerender rewrite query", () => {
  test("preserves destination query for static GSP hydration", async ({ page }) => {
    await expectHydratedQuery(
      page,
      "/prerender-rewrite?visible=browser&same=visible",
      {},
      { same: "destination", from: "config" },
      { visible: "browser", same: "destination", from: "config" },
    );
  });

  test("preserves destination query with encoded dynamic params", async ({ page }) => {
    await expectHydratedQuery(
      page,
      "/prerender-rewrite-dynamic/a%2Fb?visible=browser&same=visible",
      { slug: "a/b" },
      { same: "destination", from: "config", slug: "a/b" },
      { visible: "browser", same: "destination", from: "config", slug: "a/b" },
    );
  });

  test("preserves destination query with absent optional params", async ({ page }) => {
    await expectHydratedQuery(
      page,
      "/prerender-rewrite-optional?visible=browser&same=visible",
      {},
      { same: "destination", from: "config" },
      { visible: "browser", same: "destination", from: "config" },
    );
  });
});
