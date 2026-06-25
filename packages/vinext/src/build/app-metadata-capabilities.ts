import fs from "node:fs";
import path from "node:path";
import { parseAst } from "vite";
import type { AppRoute } from "../routing/app-router.js";
import {
  forEachAstChild,
  getAstName,
  isAstRecord,
  nodeArray,
  type AstRecord,
} from "../plugins/ast-utils.js";

const BASIC_METADATA_KEYS = new Set(["title", "description"]);
const EXPRESSION_WRAPPERS = new Set([
  "ChainExpression",
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSInstantiationExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
]);
const FUNCTION_BOUNDARIES = new Set([
  "ArrowFunctionExpression",
  "ClassDeclaration",
  "ClassExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);

function parseLanguage(filePath: string): "js" | "jsx" | "ts" | "tsx" {
  const extension = path.extname(filePath).slice(1);
  if (extension === "tsx") return "tsx";
  if (extension === "jsx") return "jsx";
  if (extension === "ts" || extension === "mts" || extension === "cts") return "ts";
  return "js";
}

function unwrapExpression(value: unknown): AstRecord | null {
  let node = isAstRecord(value) ? value : null;
  while (node && EXPRESSION_WRAPPERS.has(node.type)) {
    node = isAstRecord(node.expression) ? node.expression : null;
  }
  return node;
}

function metadataPropertyName(property: AstRecord): string | null {
  if (property.type !== "Property") return null;
  if (property.computed === true) {
    const key = unwrapExpression(property.key);
    return key?.type === "Literal" && typeof key.value === "string" ? key.value : null;
  }
  return getAstName(property.key);
}

function isBasicMetadataObject(value: unknown): boolean {
  const node = unwrapExpression(value);
  if (!node || node.type !== "ObjectExpression") return false;

  for (const propertyValue of nodeArray(node.properties)) {
    if (!isAstRecord(propertyValue)) return false;
    const name = metadataPropertyName(propertyValue);
    if (name === null || !BASIC_METADATA_KEYS.has(name)) return false;
  }
  return true;
}

function generateMetadataReturnsOnlyBasicFields(value: unknown): boolean {
  const fn = unwrapExpression(value);
  if (
    !fn ||
    (fn.type !== "ArrowFunctionExpression" &&
      fn.type !== "FunctionDeclaration" &&
      fn.type !== "FunctionExpression")
  ) {
    return false;
  }

  const body = unwrapExpression(fn.body);
  if (!body) return false;
  if (body.type !== "BlockStatement") return isBasicMetadataObject(body);

  let sawReturn = false;
  let valid = true;
  const visit = (node: AstRecord): void => {
    if (!valid) return;
    if (node.type === "ReturnStatement") {
      sawReturn = true;
      valid = isBasicMetadataObject(node.argument);
      return;
    }
    if (FUNCTION_BOUNDARIES.has(node.type)) return;
    forEachAstChild(node, visit);
  };
  for (const statement of nodeArray(body.body)) {
    if (isAstRecord(statement)) visit(statement);
  }
  return sawReturn && valid;
}

function exportedName(specifier: AstRecord): string | null {
  return getAstName(specifier.exported);
}

/**
 * Returns true only when a route module's metadata exports are statically
 * limited to title and description. Unknown source shapes fail closed.
 */
export function metadataModuleCanUseBasicRuntime(filePath: string): boolean {
  try {
    const source = fs.readFileSync(filePath, "utf8");
    const program = parseAst(source, { lang: parseLanguage(filePath) });

    for (const statement of program.body) {
      if (statement.type === "ExportAllDeclaration") return false;
      if (statement.type !== "ExportNamedDeclaration") continue;

      for (const specifier of statement.specifiers) {
        if (!isAstRecord(specifier)) continue;
        const name = exportedName(specifier);
        if (name === "metadata" || name === "generateMetadata") return false;
      }

      const declaration = statement.declaration;
      if (!declaration) continue;

      if (declaration.type === "FunctionDeclaration") {
        if (
          getAstName(declaration.id) === "generateMetadata" &&
          !generateMetadataReturnsOnlyBasicFields(declaration)
        ) {
          return false;
        }
        continue;
      }

      if (declaration.type !== "VariableDeclaration") continue;
      for (const declaratorValue of declaration.declarations) {
        if (!isAstRecord(declaratorValue)) continue;
        const name = getAstName(declaratorValue.id);
        if (name === "metadata" && !isBasicMetadataObject(declaratorValue.init)) return false;
        if (
          name === "generateMetadata" &&
          !generateMetadataReturnsOnlyBasicFields(declaratorValue.init)
        ) {
          return false;
        }
      }
    }
    return true;
  } catch {
    return false;
  }
}

function routeModulePaths(route: AppRoute): string[] {
  return [
    ...route.layouts,
    route.pagePath,
    ...route.parallelSlots.flatMap((slot) => [slot.layoutPath, slot.pagePath, slot.defaultPath]),
  ].filter((modulePath): modulePath is string => modulePath !== null);
}

export function appRoutesCanUseBasicMetadataRuntime(routes: readonly AppRoute[]): boolean {
  const inspected = new Set<string>();
  for (const route of routes) {
    for (const modulePath of routeModulePaths(route)) {
      if (inspected.has(modulePath)) continue;
      inspected.add(modulePath);
      if (!metadataModuleCanUseBasicRuntime(modulePath)) return false;
    }
  }
  return true;
}
