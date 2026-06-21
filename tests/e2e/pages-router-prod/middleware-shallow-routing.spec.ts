import { test, expect } from "@playwright/test";
import { waitForHydration } from "../helpers";

const BASE = "http://localhost:4175";

// Ported from Next.js: test/e2e/middleware-general/test/index.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/middleware-general/test/index.test.ts
test("same-page middleware rewrite stays shallow", async ({ page }) => {
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

test("cross-page navigation is not shallow just because middleware is present", async ({
  page,
}) => {
  await page.goto(`${BASE}/sha`);
  await expect(page.locator("h1")).toHaveText("Shallow Routing Test");
  await waitForHydration(page);

  const callId = await page.locator('[data-testid="gssp-call-id"]').textContent();
  const requests: string[] = [];
  page.on("request", (request) => requests.push(new URL(request.url()).pathname));

  await page.evaluate(() =>
    (window as any).next.router.push("/about", undefined, { shallow: true }),
  );

  await expect(page).toHaveURL(`${BASE}/about`);
  await expect(page.locator("h1")).toHaveText("About");
  expect(await page.locator('[data-testid="gssp-call-id"]').count()).toBe(0);
  expect(
    requests.some((pathname) => pathname === "/about" || pathname.includes("/_next/data/")),
  ).toBe(true);
  expect(callId).not.toBeNull();
});

test("Back and Forward stay shallow only between consecutive shallow entries", async ({ page }) => {
  await page.goto(`${BASE}/sha?hello=initial`);
  await expect(page.locator("h1")).toHaveText("Shallow Routing Test");
  await waitForHydration(page);

  const requests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/sha" || url.pathname.startsWith("/_next/data/")) {
      requests.push(url.pathname + url.search);
    }
  });

  await page.evaluate(() =>
    (window as any).next.router.push("/sha?hello=one", undefined, { shallow: true }),
  );
  await expect(page.locator('[data-testid="router-query"]')).toHaveText('{"hello":"one"}');

  await page.evaluate(() =>
    (window as any).next.router.push("/sha?hello=two", undefined, { shallow: true }),
  );
  await expect(page.locator('[data-testid="router-query"]')).toHaveText('{"hello":"two"}');
  const shallowCallId = await page.locator('[data-testid="gssp-call-id"]').textContent();
  requests.length = 0;

  await page.goBack();
  await expect(page).toHaveURL(`${BASE}/sha?hello=one`);
  await expect(page.locator('[data-testid="router-query"]')).toHaveText('{"hello":"one"}');
  expect(await page.locator('[data-testid="gssp-call-id"]').textContent()).toBe(shallowCallId);
  expect(requests).toEqual([]);

  await page.goForward();
  await expect(page).toHaveURL(`${BASE}/sha?hello=two`);
  await expect(page.locator('[data-testid="router-query"]')).toHaveText('{"hello":"two"}');
  expect(await page.locator('[data-testid="gssp-call-id"]').textContent()).toBe(shallowCallId);
  expect(requests).toEqual([]);

  await page.goBack();
  await page.goBack();
  await expect(page).toHaveURL(`${BASE}/sha?hello=initial`);
  await expect(page.locator('[data-testid="router-query"]')).toHaveText(
    '{"hello":"initial","from":"middleware"}',
  );
  const deepCallId = await page.locator('[data-testid="gssp-call-id"]').textContent();
  expect(deepCallId).not.toBe(shallowCallId);

  requests.length = 0;
  await page.goForward();
  await expect(page).toHaveURL(`${BASE}/sha?hello=one`);
  await expect(page.locator('[data-testid="router-query"]')).toHaveText(
    '{"hello":"one","from":"middleware"}',
  );
  expect(await page.locator('[data-testid="gssp-call-id"]').textContent()).not.toBe(deepCallId);
  expect(requests.length).toBeGreaterThan(0);
});
