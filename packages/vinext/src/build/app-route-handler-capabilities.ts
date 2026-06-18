import fs from "node:fs";
import path from "node:path";
import { parseAst } from "vite";
import type { AppRoute } from "../routing/app-router.js";

function parseLanguage(filePath: string): "js" | "jsx" | "ts" | "tsx" {
  const extension = path.extname(filePath).slice(1);
  if (extension === "tsx") return "tsx";
  if (extension === "jsx") return "jsx";
  if (extension === "ts" || extension === "mts" || extension === "cts") return "ts";
  return "js";
}

function usesFullRouteHandlerRuntime(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(usesFullRouteHandlerRuntime);
  if (!value || typeof value !== "object") return false;

  const node = value as Record<string, unknown>;
  if (node.type === "ImportExpression") return true;
  if (
    node.type === "Identifier" &&
    (node.name === "arguments" || node.name === "fetch" || node.name === "require")
  ) {
    return true;
  }
  return Object.values(node).some(usesFullRouteHandlerRuntime);
}

function isSimpleGetRouteHandler(filePath: string): boolean {
  try {
    const source = fs.readFileSync(filePath, "utf8");
    const program = parseAst(source, { lang: parseLanguage(filePath) });
    let hasGet = false;

    for (const node of program.body) {
      if (
        node.type === "ImportDeclaration" ||
        node.type === "ExportAllDeclaration" ||
        node.type === "ExportDefaultDeclaration"
      ) {
        return false;
      }
      if (node.type !== "ExportNamedDeclaration") continue;
      if (node.source !== null || node.specifiers.length > 0) return false;
      if (node.declaration?.type !== "FunctionDeclaration") return false;
      if (node.declaration.id?.name !== "GET" || node.declaration.params.length !== 0) {
        return false;
      }
      hasGet = true;
    }

    return hasGet && !usesFullRouteHandlerRuntime(program);
  } catch {
    return false;
  }
}

/**
 * Returns true when every route handler can use the no-request-context fast
 * path. The accepted shape is deliberately narrow: a static route exporting
 * only a zero-argument `GET` function from a module with no imports.
 */
export function appRoutesCanUseSimpleRouteHandlerRuntime(routes: readonly AppRoute[]): boolean {
  let hasRouteHandler = false;

  for (const route of routes) {
    if (!route.routePath) continue;
    hasRouteHandler = true;
    if (route.isDynamic || !isSimpleGetRouteHandler(route.routePath)) return false;
  }

  return hasRouteHandler;
}
