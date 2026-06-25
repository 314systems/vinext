import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire, isBuiltin } from "node:module";
import MagicString from "magic-string";
import { parseAst, type Plugin } from "vite";
import {
  forEachAstChild,
  hasRange,
  isAstRecord,
  nodeArray,
  type AstRange,
  type AstRecord,
} from "./ast-utils.js";

const REQUIRE_PROXY_PREFIX = "virtual:vinext-require-condition:";
const REQUIRE_MODULE_SUFFIX = ".vinext-require.js";

type StaticRequire = {
  argument: AstRange;
  call: AstRange;
  specifier: string;
};

export function createRequireExportConditionPlugin(): Plugin {
  const clientRequireModules = new Map<string, string>();
  const serverRequireModules = new Map<string, string>();
  const externalRequireModules = new Map<string, string>();

  return {
    name: "vinext:require-export-condition",
    enforce: "pre",
    sharedDuringBuild: true,
    transform: {
      filter: {
        id: /\.(?:[cm]?[jt]s|[jt]sx)(?:\?.*)?$/i,
        code: /\brequire\s*\(/,
      },
      async handler(code, id) {
        if (this.environment && this.environment.name !== "rsc") return null;
        if (id.includes("node_modules")) return null;

        let ast: unknown;
        try {
          ast = parseAst(code, { lang: langForId(id) });
        } catch {
          return null;
        }
        if (hasRequireBinding(ast)) return null;

        const requires = collectStaticPackageRequires(ast);
        if (requires.length === 0) return null;

        let output: MagicString | undefined;
        for (const requireCall of requires) {
          const resolved = await this.resolve(requireCall.specifier, id, {
            skipSelf: true,
            kind: "require-call",
          });
          if (!resolved || isVirtualId(resolved.id)) continue;

          output ??= new MagicString(code);
          const proxyId = createRequireProxyId(requireCall.specifier, id);
          output.overwrite(
            requireCall.argument.start,
            requireCall.argument.end,
            JSON.stringify(proxyId),
          );
          output.appendRight(requireCall.call.end, ".__vinextRequireValue");
        }

        if (!output) return null;

        return {
          code: output.toString(),
          map: output.generateMap({ hires: "boundary" }),
        };
      },
    },
    async resolveId(id, importer) {
      const cleanId = id.startsWith("\0") ? id.slice(1) : id;
      const specifier = parseRequireProxySpecifier(cleanId);
      if (!specifier || !importer) return null;

      const resolved = await this.resolve(specifier, importer, {
        skipSelf: true,
        kind: "require-call",
      });
      if (!resolved || isVirtualId(resolved.id)) return resolved;
      if (resolved.external) {
        const requireModuleId = `\0${cleanId}${REQUIRE_MODULE_SUFFIX}`;
        externalRequireModules.set(requireModuleId, specifier);
        return requireModuleId;
      }

      let requireResolvedId = resolved.id;
      if (isNodeModulesId(resolved.id)) {
        try {
          requireResolvedId = createRequire(cleanModuleId(importer)).resolve(specifier);
        } catch {}
      }
      if (!(await hasLeadingUseClientDirective(requireResolvedId))) {
        const requireModuleId = `\0${cleanId}${REQUIRE_MODULE_SUFFIX}`;
        serverRequireModules.set(requireModuleId, requireResolvedId);
        return requireModuleId;
      }

      const requireModuleId = `\0${cleanId}${REQUIRE_MODULE_SUFFIX}`;
      clientRequireModules.set(requireModuleId, requireResolvedId);
      return requireModuleId;
    },
    load(id) {
      const realId = clientRequireModules.get(id);
      if (realId) {
        return `'use client';
import * as namespace from ${JSON.stringify(realId)};
const value = "default" in namespace ? namespace.default : namespace;
export { value as __vinextRequireValue };
`;
      }

      const serverId = serverRequireModules.get(id);
      if (serverId) {
        return `import * as namespace from ${JSON.stringify(serverId)};
const value = "default" in namespace ? namespace.default : namespace;
export { value as __vinextRequireValue };
`;
      }

      const specifier = externalRequireModules.get(id);
      if (!specifier) return null;
      return `import { createRequire } from "node:module";
const value = createRequire(import.meta.url)(${JSON.stringify(specifier)});
export { value as __vinextRequireValue };
`;
    },
  };
}

function createRequireProxyId(specifier: string, importer: string): string {
  const importerHash = createHash("sha256").update(importer).digest("hex").slice(0, 16);
  return `${REQUIRE_PROXY_PREFIX}${importerHash}:${encodeURIComponent(specifier)}`;
}

function parseRequireProxySpecifier(id: string): string | null {
  if (!id.startsWith(REQUIRE_PROXY_PREFIX)) return null;
  const separator = id.indexOf(":", REQUIRE_PROXY_PREFIX.length);
  if (separator === -1) return null;
  try {
    return decodeURIComponent(id.slice(separator + 1));
  } catch {
    return null;
  }
}

function cleanModuleId(id: string): string {
  return id.split("?", 1)[0] ?? id;
}

function isVirtualId(id: string): boolean {
  return id.startsWith("\0") || id.startsWith("virtual:");
}

function isNodeModulesId(id: string): boolean {
  return id.replaceAll("\\", "/").includes("/node_modules/");
}

async function hasLeadingUseClientDirective(id: string): Promise<boolean> {
  const filePath = id.split("?", 1)[0] ?? id;
  try {
    return getLeadingReactDirective(await readFile(filePath, "utf8")) === "use client";
  } catch {
    return false;
  }
}

function getLeadingReactDirective(code: string): "use client" | "use server" | null {
  let index = code.charCodeAt(0) === 0xfeff ? 1 : 0;
  if (code[index] === "#" && code[index + 1] === "!") {
    const newline = code.indexOf("\n", index);
    if (newline === -1) return null;
    index = newline + 1;
  }

  while (index < code.length) {
    while (index < code.length && /\s/.test(code[index] ?? "")) index++;
    if (code[index] === "/" && code[index + 1] === "/") {
      const newline = code.indexOf("\n", index + 2);
      if (newline === -1) return null;
      index = newline + 1;
      continue;
    }
    if (code[index] === "/" && code[index + 1] === "*") {
      const end = code.indexOf("*/", index + 2);
      if (end === -1) return null;
      index = end + 2;
      continue;
    }

    const quote = code[index];
    if (quote !== '"' && quote !== "'") return null;
    const closing = code.indexOf(quote, index + 1);
    if (closing === -1) return null;
    const directive = code.slice(index + 1, closing);
    if (directive === "use client" || directive === "use server") return directive;
    index = closing + 1;
    while (
      index < code.length &&
      (code[index] === ";" || code[index] === " " || code[index] === "\t")
    ) {
      index++;
    }
    if (code[index] === "\n") index++;
  }
  return null;
}

function hasRequireBinding(ast: unknown): boolean {
  let found = false;

  function visit(value: unknown): void {
    if (found || !isAstRecord(value)) return;

    if (
      (value.type === "VariableDeclarator" && isRequireBinding(value.id)) ||
      ((value.type === "FunctionDeclaration" ||
        value.type === "FunctionExpression" ||
        value.type === "ArrowFunctionExpression") &&
        nodeArray(value.params).some(isRequireBinding)) ||
      (value.type === "CatchClause" && isRequireBinding(value.param)) ||
      ((value.type === "ImportDefaultSpecifier" ||
        value.type === "ImportNamespaceSpecifier" ||
        value.type === "ImportSpecifier") &&
        isRequireBinding(value.local)) ||
      ((value.type === "FunctionDeclaration" || value.type === "ClassDeclaration") &&
        isRequireBinding(value.id))
    ) {
      found = true;
      return;
    }

    forEachAstChild(value, visit);
  }

  visit(ast);
  return found;
}

function isRequireBinding(value: unknown): boolean {
  if (!isAstRecord(value)) return false;
  if (value.type === "Identifier") return value.name === "require";
  if (value.type === "AssignmentPattern") return isRequireBinding(value.left);
  if (value.type === "RestElement") return isRequireBinding(value.argument);
  if (value.type === "ArrayPattern") return nodeArray(value.elements).some(isRequireBinding);
  if (value.type === "ObjectPattern") {
    return nodeArray(value.properties).some((property) => {
      if (!isAstRecord(property)) return false;
      return isRequireBinding(property.type === "Property" ? property.value : property.argument);
    });
  }
  return false;
}

function langForId(id: string): "jsx" | "ts" | "tsx" {
  const cleanId = id.split("?", 1)[0]?.toLowerCase() ?? id.toLowerCase();
  if (cleanId.endsWith(".tsx")) return "tsx";
  if (cleanId.endsWith(".ts") || cleanId.endsWith(".mts") || cleanId.endsWith(".cts")) {
    return "ts";
  }
  return "jsx";
}

function collectStaticPackageRequires(ast: unknown): StaticRequire[] {
  const requires: StaticRequire[] = [];

  function visit(value: unknown): void {
    if (!isAstRecord(value)) return;
    const requireCall = parseStaticPackageRequire(value);
    if (requireCall) {
      requires.push(requireCall);
      return;
    }
    forEachAstChild(value, visit);
  }

  visit(ast);
  return requires;
}

function parseStaticPackageRequire(node: AstRecord): StaticRequire | null {
  if (node.type !== "CallExpression" || !hasRange(node)) return null;
  const callee = node.callee;
  if (!isAstRecord(callee) || callee.type !== "Identifier" || callee.name !== "require") {
    return null;
  }

  const args = nodeArray(node.arguments);
  if (args.length !== 1) return null;
  const argument = args[0];
  if (!isAstRecord(argument) || !hasRange(argument)) return null;

  const specifier = stringLiteralValue(argument);
  if (!specifier || !isPackageSpecifier(specifier)) return null;
  return { argument, call: node, specifier };
}

function stringLiteralValue(node: AstRecord): string | null {
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "StringLiteral" && typeof node.value === "string") return node.value;
  return null;
}

function isPackageSpecifier(specifier: string): boolean {
  return (
    !specifier.startsWith(".") &&
    !specifier.startsWith("/") &&
    !specifier.startsWith("\\") &&
    !isBuiltin(specifier) &&
    !specifier.includes("\0")
  );
}
