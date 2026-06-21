/**
 * Ported from Next.js: test/e2e/opentelemetry/client-trace-metadata/client-trace-metadata.test.ts
 * https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/opentelemetry/client-trace-metadata/client-trace-metadata.test.ts
 */
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { ViteDevServer } from "vite";
import { fetchHtml, startFixtureServer } from "./helpers.js";

const APP_FIXTURE = path.resolve(import.meta.dirname, "fixtures/client-trace-metadata-app");
const PAGES_FIXTURE = path.resolve(import.meta.dirname, "fixtures/client-trace-metadata-pages");

let server: ViteDevServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  Reflect.deleteProperty(globalThis, Symbol.for("opentelemetry.js.api.1"));
});

function expectTraceMetadata(html: string) {
  expect(html).toContain('<meta name="my-test-key-1" content="my-test-value-1"/>');
  expect(html).toContain('<meta name="my-test-key-2" content="my-test-value-2"/>');
  expect(html).toContain('<meta name="my-parent-span-id" content="abc123def4567890"/>');
  expect(html).not.toContain("non-metadata-key-3");
}

describe("clientTraceMetadata SSR", () => {
  it("injects propagation data for an App Router page", async () => {
    const fixture = await startFixtureServer(APP_FIXTURE, { appRouter: true });
    server = fixture.server;
    const { html } = await fetchHtml(fixture.baseUrl, "/");
    expectTraceMetadata(html);
  });

  it("injects propagation data for a Pages Router page", async () => {
    const fixture = await startFixtureServer(PAGES_FIXTURE);
    server = fixture.server;
    const { html } = await fetchHtml(fixture.baseUrl, "/");
    expectTraceMetadata(html);
  });
});
