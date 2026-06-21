import { expect, test } from "@playwright/test";

test("renders compiled styled-jsx CSS in streamed Pages SSR", async ({ request, baseURL }) => {
  // Ported from Next.js: test/e2e/streaming-ssr/index.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/streaming-ssr/index.test.ts
  const response = await request.get(`${baseURL}/styled-jsx-streaming`);
  expect(response.status()).toBe(200);

  const html = await response.text();
  expect(html).toMatch(/color:(?:blue|#00f)/);
  expect(html).toMatch(/class="jsx-[^"]+"/);
  expect(html).not.toContain("<style jsx");
});
