import path from "node:path";
import MagicString from "magic-string";
import { parseAst, type Plugin } from "vite";
import type { AppRouteRuntime } from "../build/app-route-runtime.js";

export const APP_ROUTE_RUNTIME_QUERY = "__vinext_app_runtime";

const SCRIPT_EXTENSION_RE = /\.(?:[cm]?[jt]sx?)$/i;

function splitId(id: string): { pathname: string; query: string; search: URLSearchParams } {
  const queryIndex = id.indexOf("?");
  const query = queryIndex === -1 ? "" : id.slice(queryIndex + 1);
  return {
    pathname: queryIndex === -1 ? id : id.slice(0, queryIndex),
    query,
    search: new URLSearchParams(query),
  };
}

function withoutAppRouteRuntime(id: string): string {
  const { pathname, query } = splitId(id);
  const remainingQuery = query
    .split("&")
    .filter((part) => part.split("=", 1)[0] !== APP_ROUTE_RUNTIME_QUERY)
    .join("&");
  return remainingQuery ? `${pathname}?${remainingQuery}` : pathname;
}

function runtimeFromId(id: string): AppRouteRuntime | null {
  const runtime = splitId(id).search.get(APP_ROUTE_RUNTIME_QUERY);
  return runtime === "edge" || runtime === "nodejs" ? runtime : null;
}

export function withAppRouteRuntime(id: string, runtime: AppRouteRuntime): string {
  const idWithoutRuntime = withoutAppRouteRuntime(id);
  return `${idWithoutRuntime}${idWithoutRuntime.includes("?") ? "&" : "?"}${APP_ROUTE_RUNTIME_QUERY}=${runtime}`;
}

function isScriptModule(id: string): boolean {
  return SCRIPT_EXTENSION_RE.test(splitId(id).pathname);
}

type AstNode = Record<string, unknown> & { end?: number; start?: number; type?: string };

function walkAst(value: unknown, visitor: (node: AstNode) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walkAst(item, visitor);
    return;
  }
  if (!value || typeof value !== "object") return;
  const node = value as AstNode;
  if (typeof node.type === "string") visitor(node);
  for (const [key, child] of Object.entries(node)) {
    if (key !== "parent") walkAst(child, visitor);
  }
}

function replaceNextRuntime(code: string, id: string, runtime: AppRouteRuntime) {
  const extension = path.extname(splitId(id).pathname).slice(1);
  const lang =
    extension === "tsx" || extension === "ts" ? extension : extension === "jsx" ? "jsx" : "js";
  let ast: ReturnType<typeof parseAst>;
  try {
    ast = parseAst(code, { lang });
  } catch {
    return null;
  }

  const output = new MagicString(code);
  let changed = false;
  walkAst(ast.body, (node) => {
    if (node.type !== "MemberExpression" || node.computed !== false) return;
    const property = node.property as AstNode & { name?: unknown };
    const object = node.object as AstNode & {
      computed?: unknown;
      object?: unknown;
      property?: unknown;
    };
    if (
      property?.type !== "Identifier" ||
      property.name !== "NEXT_RUNTIME" ||
      object?.type !== "MemberExpression" ||
      object.computed !== false
    ) {
      return;
    }
    const envProperty = object.property as AstNode & { name?: unknown };
    const processObject = object.object as AstNode & { name?: unknown };
    if (
      envProperty?.type !== "Identifier" ||
      envProperty.name !== "env" ||
      processObject?.type !== "Identifier" ||
      processObject.name !== "process" ||
      typeof node.start !== "number" ||
      typeof node.end !== "number"
    ) {
      return;
    }
    output.overwrite(node.start, node.end, JSON.stringify(runtime));
    changed = true;
  });
  if (!changed) return null;
  return {
    code: output.toString(),
    map: output.generateMap({ hires: "boundary", includeContent: true, source: id }),
  };
}

export function createAppRouteRuntimePlugin(): Plugin {
  return {
    name: "vinext:app-route-runtime",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (this.environment?.name === "client") {
        if (!runtimeFromId(source)) return null;
        return this.resolve(withoutAppRouteRuntime(source), importer, {
          ...options,
          skipSelf: true,
        });
      }

      if (!importer || options?.isEntry) return null;
      const runtime = runtimeFromId(importer);
      if (!runtime || source.startsWith("\0") || source.startsWith("virtual:")) return null;

      const resolved = await this.resolve(source, splitId(importer).pathname, {
        ...options,
        skipSelf: true,
      });
      if (!resolved || !isScriptModule(resolved.id)) {
        return resolved;
      }
      return {
        ...resolved,
        id: withAppRouteRuntime(resolved.id, runtime),
        external: false,
      };
    },
    transform: {
      filter: { id: /[?&]__vinext_app_runtime=(?:edge|nodejs)(?:&|$)/ },
      handler(code, id) {
        if (this.environment?.name === "client") return null;
        const runtime = runtimeFromId(id);
        if (!runtime || !code.includes("process.env.NEXT_RUNTIME")) return null;
        return replaceNextRuntime(code, id, runtime);
      },
    },
  };
}
