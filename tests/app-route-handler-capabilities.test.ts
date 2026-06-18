import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appRoutesCanUseSimpleRouteHandlerRuntime } from "../packages/vinext/src/build/app-route-handler-capabilities.js";
import type { AppRoute } from "../packages/vinext/src/routing/app-router.js";

const temporaryDirectories: string[] = [];

function writeRoute(source: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-simple-route-"));
  temporaryDirectories.push(root);
  const filePath = path.join(root, "app", "api", "route.ts");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, source);
  return filePath;
}

function makeRoute(routePath: string, isDynamic = false): AppRoute {
  return {
    errorPath: null,
    forbiddenPath: null,
    forbiddenPaths: [],
    isDynamic,
    layoutErrorPaths: [],
    layouts: [],
    layoutTreePositions: [],
    loadingPath: null,
    notFoundPath: null,
    notFoundPaths: [],
    pagePath: null,
    parallelSlots: [],
    params: [],
    pattern: "/api",
    patternParts: ["api"],
    routePath,
    routeSegments: ["api"],
    siblingIntercepts: [],
    templates: [],
    unauthorizedPath: null,
    unauthorizedPaths: [],
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("simple App route handler capability", () => {
  it("accepts static zero-argument GET-only modules", () => {
    const first = writeRoute('export function GET() { return Response.json({ status: "ok" }); }');
    const second = writeRoute("export async function GET() { return new Response('ok'); }");

    expect(
      appRoutesCanUseSimpleRouteHandlerRuntime([
        makeRoute(first),
        { ...makeRoute(second), pattern: "/health" },
      ]),
    ).toBe(true);
  });

  it.each([
    ['import { headers } from "next/headers"; export function GET() {}', false],
    ["export function GET(request) {}", false],
    ["export function GET() { return fetch('https://example.com'); }", false],
    ["export function GET() { return import('./data'); }", false],
    ["export function GET() { return arguments[0]; }", false],
    ["export const revalidate = 60; export function GET() {}", false],
    ["export function POST() {}", false],
  ])("rejects unsupported source %#", (source, expected) => {
    expect(appRoutesCanUseSimpleRouteHandlerRuntime([makeRoute(writeRoute(source))])).toBe(
      expected,
    );
  });

  it("rejects dynamic and unreadable route handlers", () => {
    const routePath = writeRoute("export function GET() { return new Response('ok'); }");
    expect(appRoutesCanUseSimpleRouteHandlerRuntime([makeRoute(routePath, true)])).toBe(false);
    expect(appRoutesCanUseSimpleRouteHandlerRuntime([makeRoute("/missing/app/api/route.ts")])).toBe(
      false,
    );
  });
});
