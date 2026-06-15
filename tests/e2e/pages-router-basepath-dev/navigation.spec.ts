import { expect, test } from "@playwright/test";

// Ported from Next.js: test/e2e/basepath/router-events.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/basepath/router-events.test.ts
test("loads the target page module through the dev server basePath", async ({ page }) => {
  const moduleRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith("/pages/about.tsx")) {
      moduleRequests.push(url.pathname + url.search);
    }
  });

  await page.goto("/docs/");
  await page.waitForFunction(() => Boolean((window as any).__VINEXT_ROOT__));
  await page.evaluate(() => {
    (window as any).__VINEXT_SOFT_NAV_MARKER__ = true;
  });

  const initialNavigationEntries = await page.evaluate(
    () => performance.getEntriesByType("navigation").length,
  );
  await page.getByRole("link", { name: "About" }).click();

  await expect(page.getByRole("heading", { name: "About" })).toBeVisible();
  await expect(page).toHaveURL(/\/docs\/about$/);
  expect(await page.evaluate(() => performance.getEntriesByType("navigation").length)).toBe(
    initialNavigationEntries,
  );
  expect(await page.evaluate(() => (window as any).__VINEXT_SOFT_NAV_MARKER__)).toBe(true);
  expect(moduleRequests).toContain("/docs/pages/about.tsx?import");
  expect(moduleRequests).not.toContain("/pages/about.tsx?import");
  expect(moduleRequests.every((request) => request.startsWith("/docs/"))).toBe(true);
});
