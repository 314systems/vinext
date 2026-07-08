import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4173";

test.describe("next/script", () => {
  // Ported from Next.js: packages/next/src/client/script.tsx
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/client/script.tsx
  // Next.js retains ScriptCache entries after remote scripts load, so a script
  // emitted by _document is not reloaded by page components with different ids.
  test("deduplicates loaded same-src scripts across different ids", async ({ page }) => {
    await page.goto(`${BASE}/script-dedupe`);
    await expect(page.getByRole("heading", { name: "Script Dedupe" })).toBeVisible();

    await expect.poll(() => page.locator('script[src="/dedupe-script.js"]').count()).toBe(1);
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, "__vinextScriptDedupeExecutions")))
      .toBe(1);
  });

  test("fires onReady for hydrated and remounted beforeInteractive scripts", async ({ page }) => {
    await page.goto(`${BASE}/script-before-ready`);
    await expect(page.getByRole("heading", { name: "Before Interactive Ready" })).toBeVisible();

    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, "__vinextBeforeReadyCalls")))
      .toBe(1);

    const toggle = page.getByRole("button", { name: "Toggle script" });
    await toggle.click();
    await toggle.click();

    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, "__vinextBeforeReadyCalls")))
      .toBe(2);
  });
});
