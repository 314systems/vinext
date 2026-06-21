import { test, expect } from "@playwright/test";
import { waitForHydration } from "../helpers";

const BASE = "http://localhost:4175";

// Extends the shallow-routing scenario from Next.js with middleware-injected query state:
// https://github.com/vercel/next.js/blob/canary/test/e2e/middleware-general/test/index.test.ts
test("middleware alias supports deep then shallow navigation", async ({ page }) => {
  await page.goto(`${BASE}/sha`);
  await expect(page.locator("h1")).toHaveText("Shallow Routing Test");
  await waitForHydration(page);

  const initialCallId = await page.locator('[data-testid="gssp-call-id"]').textContent();
  await page.evaluate(() => (window as any).next.router.push("/sha?hello=goodbye"));
  await expect(page).toHaveURL(`${BASE}/sha?hello=goodbye`);
  await expect(page.locator('[data-testid="router-query"]')).toHaveText(
    '{"hello":"goodbye","from":"middleware"}',
  );
  await expect
    .poll(() => page.evaluate(() => (window as any).__NEXT_DATA__.query))
    .toEqual({ hello: "goodbye", from: "middleware" });
  const deepCallId = await page.locator('[data-testid="gssp-call-id"]').textContent();
  expect(deepCallId).not.toBe(initialCallId);

  await page.evaluate(() =>
    (window as any).next.router.push("/sha?hello=world", undefined, { shallow: true }),
  );
  await expect(page).toHaveURL(`${BASE}/sha?hello=world`);
  await expect(page.locator('[data-testid="router-query"]')).toHaveText('{"hello":"world"}');
  expect(await page.locator('[data-testid="gssp-call-id"]').textContent()).toBe(deepCallId);

  await page.goBack();
  await expect(page).toHaveURL(`${BASE}/sha?hello=goodbye`);
  await expect(page.locator('[data-testid="router-query"]')).toHaveText(
    '{"hello":"goodbye","from":"middleware"}',
  );
  await page.goForward();
  await expect(page).toHaveURL(`${BASE}/sha?hello=world`);
  await expect(page.locator('[data-testid="router-query"]')).toHaveText(
    '{"hello":"world","from":"middleware"}',
  );

  await page.reload();
  await waitForHydration(page);
  await expect(page.locator('[data-testid="router-query"]')).toHaveText('{"hello":"world"}');
  const reloadCallId = await page.locator('[data-testid="gssp-call-id"]').textContent();
  expect(reloadCallId).not.toBe(deepCallId);
});
