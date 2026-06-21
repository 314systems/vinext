import fs from "node:fs";
import type { AppRoute } from "../routing/app-router.js";
import { extractExportConstString } from "./report.js";

export type AppRouteRuntime = "edge" | "nodejs";

function readSegmentRuntime(filePath: string): AppRouteRuntime | null {
  let source: string;
  try {
    source = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  const runtime = extractExportConstString(source, "runtime");
  if (runtime === "edge" || runtime === "experimental-edge") return "edge";
  if (runtime === "nodejs") return "nodejs";
  return null;
}

export function resolveAppRouteBuildRuntime(route: AppRoute): AppRouteRuntime {
  if (route.routePath) {
    return readSegmentRuntime(route.routePath) ?? "nodejs";
  }

  let runtime: AppRouteRuntime = "nodejs";
  for (const filePath of [...route.layouts, route.pagePath]) {
    if (!filePath) continue;
    runtime = readSegmentRuntime(filePath) ?? runtime;
  }
  return runtime;
}
