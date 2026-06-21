import fs from "node:fs/promises";
import path from "node:path";
import MagicString from "magic-string";
import { parseAst, type Plugin } from "vite";
import type { AppRouteRuntime } from "../build/app-route-runtime.js";

export const APP_ROUTE_RUNTIME_QUERY = "__vinext_app_runtime";

const SCRIPT_EXTENSION_RE = /\.(?:[cm]?[jt]sx?)$/i;

function splitId(id: string): { pathname: string; search: URLSearchParams } {
  const queryIndex = id.indexOf("?");
  return {
    pathname: queryIndex === -1 ? id : id.slice(0, queryIndex),
    search: new URLSearchParams(queryIndex === -1 ? "" : id.slice(queryIndex + 1)),
  };
}

function runtimeFromId(id: string): AppRouteRuntime | null {
  const runtime = splitId(id).search.get(APP_ROUTE_RUNTIME_QUERY);
  return runtime === "edge" || runtime === "nodejs" ? runtime : null;
}

export function withAppRouteRuntime(id: string, runtime: AppRouteRuntime): string {
  const { pathname, search } = splitId(id);
  search.set(APP_ROUTE_RUNTIME_QUERY, runtime);
  return `${pathname}?${search.toString()}`;
}

function isScriptModule(id: string): boolean {
  return SCRIPT_EXTENSION_RE.test(splitId(id).pathname);
}

function isProjectModule(id: string, root: string): boolean {
  const pathname = splitId(id).pathname;
  const relative = path.relative(root, pathname);
  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !relative.split(path.sep).includes("node_modules")
  );
}

type AstNode = Record<string, unknown> & { end?: number; start?: number; type?: string };

function isRelativeScriptSpecifier(specifier: string): boolean {
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) return false;
  const extension = path.extname(splitId(specifier).pathname);
  return extension === "" || SCRIPT_EXTENSION_RE.test(extension);
}

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

function rewriteRelativeImports(code: string, id: string, runtime: AppRouteRuntime): string {
  const pathname = splitId(id).pathname;
  const extension = path.extname(pathname).slice(1);
  const lang =
    extension === "tsx" || extension === "ts" ? extension : extension === "jsx" ? "jsx" : "js";
  let ast: ReturnType<typeof parseAst>;
  try {
    ast = parseAst(code, { lang });
  } catch {
    return code;
  }

  const output = new MagicString(code);
  let changed = false;
  walkAst(ast.body, (node) => {
    const source = node.source;
    if (!source || typeof source !== "object") return;
    const sourceNode = source as AstNode & { value?: unknown };
    if (
      typeof sourceNode.value !== "string" ||
      typeof sourceNode.start !== "number" ||
      typeof sourceNode.end !== "number" ||
      !isRelativeScriptSpecifier(sourceNode.value)
    ) {
      return;
    }
    output.overwrite(
      sourceNode.start,
      sourceNode.end,
      JSON.stringify(withAppRouteRuntime(sourceNode.value, runtime)),
    );
    changed = true;
  });
  return changed ? output.toString() : code;
}

export function createAppRouteRuntimePlugin(getRoot: () => string): Plugin {
  return {
    name: "vinext:app-route-runtime",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (!importer || options?.isEntry) return null;
      const runtime = runtimeFromId(importer);
      if (!runtime || source.startsWith("\0") || source.startsWith("virtual:")) return null;

      const resolved = await this.resolve(source, splitId(importer).pathname, {
        ...options,
        skipSelf: true,
      });
      if (
        !resolved ||
        resolved.external ||
        !isScriptModule(resolved.id) ||
        !isProjectModule(resolved.id, getRoot())
      ) {
        return resolved;
      }
      return { ...resolved, id: withAppRouteRuntime(resolved.id, runtime) };
    },
    load: {
      filter: { id: /[?&]__vinext_app_runtime=(?:edge|nodejs)(?:&|$)/ },
      async handler(id) {
        const runtime = runtimeFromId(id);
        let code = await fs.readFile(splitId(id).pathname, "utf8");
        if (!runtime) return code;
        code = rewriteRelativeImports(code, id, runtime);
        return code.replaceAll("process.env.NEXT_RUNTIME", JSON.stringify(runtime));
      },
    },
    transform: {
      filter: { id: /[?&]__vinext_app_runtime=(?:edge|nodejs)(?:&|$)/ },
      handler(code, id) {
        const runtime = runtimeFromId(id);
        if (!runtime || !code.includes("process.env.NEXT_RUNTIME")) return null;
        return {
          code: code.replaceAll("process.env.NEXT_RUNTIME", JSON.stringify(runtime)),
          map: null,
        };
      },
    },
  };
}
