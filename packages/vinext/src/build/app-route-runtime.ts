import fs from "node:fs";
import type { AppRoute } from "../routing/app-router.js";

export type AppRouteRuntime = "edge" | "nodejs";

const RUNTIME_EXPORT_RE =
  /\bexport\s+const\s+runtime\s*=\s*(["'])(edge|experimental-edge|nodejs)\1/;

function readSegmentRuntime(filePath: string): AppRouteRuntime | null {
  let source: string;
  try {
    source = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  const runtime = RUNTIME_EXPORT_RE.exec(source)?.[2];
  if (runtime === "edge" || runtime === "experimental-edge") return "edge";
  if (runtime === "nodejs") return "nodejs";
  return null;
}

export function resolveAppRouteBuildRuntime(route: AppRoute): AppRouteRuntime {
  let runtime: AppRouteRuntime = "nodejs";
  for (const filePath of [...route.layouts, route.pagePath, route.routePath]) {
    if (!filePath) continue;
    runtime = readSegmentRuntime(filePath) ?? runtime;
  }
  return runtime;
}
