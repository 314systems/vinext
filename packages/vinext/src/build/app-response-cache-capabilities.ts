import fs from "node:fs";
import type { AppRoute } from "../routing/app-router.js";
import { extractExportConstNumber, extractExportConstString, hasNamedExport } from "./report.js";

function readRouteSource(path: string, cache: Map<string, string | null>): string | null {
  if (cache.has(path)) return cache.get(path) ?? null;

  try {
    const source = fs.readFileSync(path, "utf8");
    cache.set(path, source);
    return source;
  } catch {
    cache.set(path, null);
    return null;
  }
}

function isProvablyForceDynamic(source: string): boolean {
  return (
    extractExportConstString(source, "dynamic") === "force-dynamic" ||
    extractExportConstNumber(source, "revalidate") === 0
  );
}

function routeHasPage(route: AppRoute): boolean {
  if (route.pagePath) return true;
  return route.parallelSlots.some((slot) => slot.pagePath !== null || slot.defaultPath !== null);
}

function pageRouteCanUseResponseCache(
  route: AppRoute,
  sourceCache: Map<string, string | null>,
): boolean {
  if (!routeHasPage(route)) return false;

  for (const layoutPath of route.layouts) {
    const source = readRouteSource(layoutPath, sourceCache);
    if (source === null) return true;
    if (isProvablyForceDynamic(source)) return false;
  }

  // A route with parallel pages can only be proven dynamic from a shared
  // ancestor layout. Keep the response cache when slot-level behavior differs.
  if (route.parallelSlots.length > 0 || !route.pagePath) return true;

  const pageSource = readRouteSource(route.pagePath, sourceCache);
  return pageSource === null || !isProvablyForceDynamic(pageSource);
}

function routeHandlerCanUseResponseCache(
  routePath: string,
  sourceCache: Map<string, string | null>,
): boolean {
  const source = readRouteSource(routePath, sourceCache);
  if (source === null) return true;
  if (extractExportConstString(source, "dynamic") === "force-dynamic") return false;

  const revalidate = extractExportConstNumber(source, "revalidate");
  if (revalidate !== null) {
    return Number.isFinite(revalidate) && revalidate > 0;
  }

  // Non-literal segment config is rejected by Next.js, but retaining the
  // runtime here is safer if a future parser accepts another static form.
  return hasNamedExport(source, "revalidate");
}

/**
 * Returns whether an App Router build can reach vinext's response-level ISR
 * store. This does not describe fetch or `"use cache"` data caching.
 */
export function appRoutesNeedResponseCache(routes: readonly AppRoute[]): boolean {
  const sourceCache = new Map<string, string | null>();

  return routes.some(
    (route) =>
      pageRouteCanUseResponseCache(route, sourceCache) ||
      (route.routePath !== null && routeHandlerCanUseResponseCache(route.routePath, sourceCache)),
  );
}

function routeModulePaths(route: AppRoute): string[] {
  return [
    ...route.layouts,
    route.pagePath,
    route.routePath,
    ...route.parallelSlots.flatMap((slot) => [slot.layoutPath, slot.pagePath, slot.defaultPath]),
  ].filter((path): path is string => path !== null);
}

/**
 * Returns whether the build-time prerender worker may need to invoke an App
 * Router `generateStaticParams` export.
 */
export function appRoutesNeedStaticParamsEndpoint(routes: readonly AppRoute[]): boolean {
  const sourceCache = new Map<string, string | null>();
  const inspected = new Set<string>();

  for (const route of routes) {
    if (!route.isDynamic) continue;

    for (const modulePath of routeModulePaths(route)) {
      if (inspected.has(modulePath)) continue;
      inspected.add(modulePath);
      const source = readRouteSource(modulePath, sourceCache);
      if (source === null || hasNamedExport(source, "generateStaticParams")) {
        return true;
      }
    }
  }

  return false;
}
