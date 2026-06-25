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
const RESOLVED_REQUIRE_PROXY_PREFIX = `\0${REQUIRE_PROXY_PREFIX}`;
const REQUIRE_MODULE_SUFFIX = ".vinext-require.js";

type StaticRequire = {
  argument: AstRange;
  specifier: string;
};

export function createRequireExportConditionPlugin(): Plugin {
  const requireModules = new Map<string, string>();

  return {
    name: "vinext:require-export-condition",
    enforce: "pre",
    sharedDuringBuild: true,
    transform: {
      filter: {
        id: /\.(?:[cm]?[jt]s|[jt]sx)(?:\?.*)?$/i,
        code: /\brequire\s*\(/,
      },
      handler(code, id) {
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

        const output = new MagicString(code);
        for (const requireCall of requires) {
          output.overwrite(
            requireCall.argument.start,
            requireCall.argument.end,
            JSON.stringify(REQUIRE_PROXY_PREFIX + encodeURIComponent(requireCall.specifier)),
          );
        }

        return {
          code: output.toString(),
          map: output.generateMap({ hires: "boundary" }),
        };
      },
    },
    async resolveId(id, importer) {
      const prefix = id.startsWith(RESOLVED_REQUIRE_PROXY_PREFIX)
        ? RESOLVED_REQUIRE_PROXY_PREFIX
        : id.startsWith(REQUIRE_PROXY_PREFIX)
          ? REQUIRE_PROXY_PREFIX
          : null;
      if (!prefix || !importer) return null;

      const specifier = decodeURIComponent(id.slice(prefix.length));
      const resolved = await this.resolve(specifier, importer, {
        skipSelf: true,
        kind: "require-call",
      });
      if (!resolved || resolved.external) return resolved;

      const requireModuleId = resolved.id + REQUIRE_MODULE_SUFFIX;
      requireModules.set(requireModuleId, resolved.id);
      return requireModuleId;
    },
    load(id) {
      const realId = requireModules.get(id);
      if (!realId) return null;
      return `'use client';
import * as namespace from ${JSON.stringify(realId)};
const value = namespace.default || namespace;
export default value;
`;
    },
  };
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
  if (node.type !== "CallExpression") return null;
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
  return { argument, specifier };
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
    !specifier.startsWith("node:") &&
    !specifier.includes("\0")
  );
}
