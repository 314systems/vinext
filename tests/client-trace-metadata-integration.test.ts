/**
 * Ported from Next.js: test/e2e/opentelemetry/client-trace-metadata/client-trace-metadata.test.ts
 * https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/opentelemetry/client-trace-metadata/client-trace-metadata.test.ts
 */
import path from "node:path";
import { context, isValidSpanId, propagation } from "@opentelemetry/api";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { ViteDevServer } from "vite";
import { fetchHtml, startFixtureServer } from "./helpers.js";

const APP_FIXTURE = path.resolve(import.meta.dirname, "fixtures/client-trace-metadata-app");
const PAGES_FIXTURE = path.resolve(import.meta.dirname, "fixtures/client-trace-metadata-pages");

let server: ViteDevServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  context.disable();
  propagation.disable();
});

function getTraceSpanId(html: string): string {
  expect(html).toContain('<meta name="my-test-key-1" content="my-test-value-1"/>');
  expect(html).not.toContain("non-metadata-key-2");
  const spanId = html.match(/<meta name="my-parent-span-id" content="([a-f0-9]{16})"\/>/)?.[1];
  expect(spanId).toBeDefined();
  expect(isValidSpanId(spanId!)).toBe(true);
  return spanId!;
}

async function expectDistinctRequestSpanIds(baseUrl: string): Promise<void> {
  const first = getTraceSpanId((await fetchHtml(baseUrl, "/")).html);
  const second = getTraceSpanId((await fetchHtml(baseUrl, "/")).html);
  expect(second).not.toBe(first);
}

describe("clientTraceMetadata SSR", () => {
  it("injects propagation data for an App Router page", async () => {
    const fixture = await startFixtureServer(APP_FIXTURE, { appRouter: true });
    server = fixture.server;
    await expectDistinctRequestSpanIds(fixture.baseUrl);
  });

  it("injects propagation data for a Pages Router page", async () => {
    const fixture = await startFixtureServer(PAGES_FIXTURE);
    server = fixture.server;
    await expectDistinctRequestSpanIds(fixture.baseUrl);
  });
});
