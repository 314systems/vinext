import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { SourceMap } from "magic-string";
import type { Plugin, Rollup, ViteDevServer } from "vite";
import { parseAstAsync, transformWithOxc } from "vite";
import { isUnknownRecord } from "../utils/record.js";
import { escapeRegExp } from "../utils/regex.js";

type RscTransforms = typeof import("@vitejs/plugin-rsc/transforms");
type RscPluginManager = NonNullable<
  ReturnType<typeof import("@vitejs/plugin-rsc").getPluginApi>
>["manager"];
type Program = Parameters<RscTransforms["transformDirectiveProxyExport"]>[0];
type ModuleDirective = NonNullable<
  Parameters<RscTransforms["transformServerActionServer"]>[2]["moduleDirective"]
> & { start?: number };
type StringDirective = ModuleDirective & { type: "Literal"; value: string };
type ExportFilter = NonNullable<Parameters<RscTransforms["transformWrapExport"]>[2]["filter"]>;
type ExportMeta = Parameters<ExportFilter>[1];
type FunctionParameters = NonNullable<ExportMeta["parameters"]>;

export type ServerFunctionDirectiveContext = {
  value: string;
  name: string;
  id: string;
  directiveMatch: RegExpMatchArray;
  location: "inline" | "module";
  hasBoundArgs: boolean;
  parameters?: FunctionParameters;
  runtime?: string;
  meta?: ExportMeta;
};

export type ServerFunctionDirective = {
  directive: string | RegExp;
  test?: (code: string) => boolean;
  filter?: (id: string) => boolean;
  validate?: (context: { id: string; directive: string; location: "inline" | "module" }) => void;
  rejectNonAsyncFunction?: boolean;
  rejectNonAsyncModule?: boolean;
  runtime?: string;
  wrap: (context: ServerFunctionDirectiveContext) => string;
  filterExport?: (context: { name: string; id: string; meta: ExportMeta }) => boolean;
  clientError?: (context: { id: string; environment: string }) => string;
};

type Options = {
  projectRoot: string;
  definitions: ServerFunctionDirective[];
  serverEnvironmentName: string;
  browserEnvironmentName: string;
};

const SERVER_FUNCTION_DIRECTIVE_MARKER = "/* __vinext_server_function_directives__ */";

type ServerReferenceMetadata = RscPluginManager["serverReferenceMetaMap"][string];

function mergeServerReferenceMetadata(
  manager: RscPluginManager,
  id: string,
  referenceKey: string,
  exportNames: Iterable<string>,
): void {
  const existing = manager.serverReferenceMetaMap[id];
  manager.serverReferenceMetaMap[id] = {
    importId: existing?.importId ?? id,
    referenceKey: existing?.referenceKey ?? referenceKey,
    exportNames: [...new Set([...(existing?.exportNames ?? []), ...exportNames])],
  };
}

function removeOwnedServerReferenceMetadata(
  manager: RscPluginManager,
  ownedReferences: Map<string, ServerReferenceMetadata>,
  id: string,
): void {
  const owned = ownedReferences.get(id);
  if (!owned) return;
  ownedReferences.delete(id);

  const existing = manager.serverReferenceMetaMap[id];
  if (!existing) return;

  const ownedExportNames = new Set(owned.exportNames);
  const exportNames = existing.exportNames.filter((name) => !ownedExportNames.has(name));
  if (exportNames.length === 0) {
    delete manager.serverReferenceMetaMap[id];
  } else {
    manager.serverReferenceMetaMap[id] = { ...existing, exportNames };
  }
}

function setOwnedServerReferenceMetadata(
  manager: RscPluginManager,
  ownedReferences: Map<string, ServerReferenceMetadata>,
  id: string,
  referenceKey: string,
  exportNames: Iterable<string>,
): void {
  removeOwnedServerReferenceMetadata(manager, ownedReferences, id);
  const metadata = {
    importId: id,
    referenceKey,
    exportNames: [...new Set(exportNames)],
  };
  ownedReferences.set(id, metadata);
  mergeServerReferenceMetadata(manager, id, referenceKey, metadata.exportNames);
}

function resolvePluginRscModule(projectRoot: string, specifier: string): string {
  try {
    return createRequire(path.join(projectRoot, "package.json")).resolve(specifier);
  } catch {}

  try {
    return createRequire(import.meta.url).resolve(specifier);
  } catch {
    throw new Error(`vinext: Installed @vitejs/plugin-rsc does not expose ${specifier}.`);
  }
}

async function parseProgram(code: string): Promise<Program> {
  return (await parseAstAsync(code)) as unknown as Program;
}

function matchDirective(value: string, directive: string | RegExp): RegExpMatchArray | undefined {
  const pattern =
    typeof directive === "string"
      ? new RegExp(`^${escapeRegExp(directive)}$`)
      : new RegExp(directive.source, directive.flags);
  pattern.lastIndex = 0;
  return value.match(pattern) ?? undefined;
}

function isStringLiteral(value: unknown): value is StringDirective {
  return isUnknownRecord(value) && value.type === "Literal" && typeof value.value === "string";
}

function isExpressionStatement(
  value: unknown,
): value is Record<string, unknown> & { type: "ExpressionStatement"; expression: unknown } {
  return isUnknownRecord(value) && value.type === "ExpressionStatement" && "expression" in value;
}

function isBlockStatement(
  value: unknown,
): value is Record<string, unknown> & { type: "BlockStatement"; body: unknown[] } {
  return isUnknownRecord(value) && value.type === "BlockStatement" && Array.isArray(value.body);
}

function findModuleDirective(
  ast: Program,
  directive: string | RegExp,
): StringDirective | undefined {
  for (const node of ast.body) {
    if (node.type !== "ExpressionStatement") continue;
    if (isStringLiteral(node.expression) && matchDirective(node.expression.value, directive)) {
      return node.expression;
    }
  }
}

function findInlineDirective(
  ast: Program,
  directive: string | RegExp,
): StringDirective | undefined {
  let result: StringDirective | undefined;

  function visit(value: unknown): void {
    if (result) return;
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (!isUnknownRecord(value)) return;

    const nodeType = typeof value.type === "string" ? value.type : undefined;
    if (
      (nodeType === "FunctionDeclaration" ||
        nodeType === "FunctionExpression" ||
        nodeType === "ArrowFunctionExpression") &&
      isBlockStatement(value.body)
    ) {
      for (const statement of value.body.body) {
        if (
          isExpressionStatement(statement) &&
          isStringLiteral(statement.expression) &&
          matchDirective(statement.expression.value, directive)
        ) {
          result = statement.expression;
          return;
        }
      }
    }

    for (const [key, child] of Object.entries(value)) {
      if (key === "parent" || key === "loc" || key === "start" || key === "end") continue;
      visit(child);
    }
  }

  visit(ast);
  return result;
}

function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function normalizeViteImportAnalysisUrl(
  environment: ViteDevServer["environments"][string],
  id: string,
): string {
  const root = environment.config.root;
  const rootPrefix = root.endsWith("/") ? root : `${root}/`;
  if (id.startsWith(rootPrefix)) return id.slice(root.length);

  const cleanId = id.split("?", 1)[0] ?? id;
  if (path.isAbsolute(cleanId) && fs.existsSync(cleanId)) return path.posix.join("/@fs/", id);
  if (id.startsWith(".") || id.startsWith("/")) return id;
  return `/@id/${id.replace("\0", "__x00__")}`;
}

async function expandExportAll(
  transforms: RscTransforms,
  context: Rollup.TransformPluginContext,
  code: string,
  ast: Program,
  id: string,
): Promise<{ code: string } | undefined> {
  return transforms.transformExpandExportAll({
    code,
    ast,
    importer: id,
    resolve: async (source, importer) => (await context.resolve(source, importer))?.id,
    load: async (resolvedId) => {
      const source = await fs.promises.readFile(resolvedId, "utf8");
      const transformed = await transformWithOxc(source, resolvedId, { sourcemap: false });
      return parseProgram(transformed.code);
    },
  });
}

export async function createServerFunctionDirectivePlugins(options: Options): Promise<Plugin[]> {
  const rscModulePath = resolvePluginRscModule(options.projectRoot, "@vitejs/plugin-rsc");
  const transformsPath = resolvePluginRscModule(
    options.projectRoot,
    "@vitejs/plugin-rsc/transforms",
  );
  const rscRuntime = pathToFileURL(
    resolvePluginRscModule(options.projectRoot, "@vitejs/plugin-rsc/react/rsc/server"),
  ).href;
  const browserRuntime = pathToFileURL(
    resolvePluginRscModule(options.projectRoot, "@vitejs/plugin-rsc/react/browser"),
  ).href;
  const ssrRuntime = pathToFileURL(
    resolvePluginRscModule(options.projectRoot, "@vitejs/plugin-rsc/react/ssr"),
  ).href;
  const encryptionRuntime = pathToFileURL(
    resolvePluginRscModule(options.projectRoot, "@vitejs/plugin-rsc/utils/encryption-runtime"),
  ).href;
  const rscModule: typeof import("@vitejs/plugin-rsc") = await import(
    pathToFileURL(rscModulePath).href
  );
  const transforms: RscTransforms = await import(pathToFileURL(transformsPath).href);
  const { getPluginApi } = rscModule;
  let manager: RscPluginManager | undefined;
  const ownedReferences = new Map<string, ServerReferenceMetadata>();
  const serverReferenceOwnership = new Map<string, boolean>();

  const transformPlugin: Plugin = {
    name: "vinext:server-function-directives",

    configResolved(config) {
      manager = getPluginApi(config)?.manager;
    },

    transform: {
      async handler(code, id) {
        if (code.includes(SERVER_FUNCTION_DIRECTIVE_MARKER)) return;

        const active = options.definitions.filter(
          (definition) =>
            (definition.test?.(code) ?? code.includes("use ")) &&
            (!definition.filter || definition.filter(id)),
        );
        const isServer = this.environment.name === options.serverEnvironmentName;
        if (!manager) {
          throw new Error("vinext: failed to access @vitejs/plugin-rsc through getPluginApi().");
        }
        if (active.length === 0) {
          if (isServer) {
            serverReferenceOwnership.set(id, false);
            removeOwnedServerReferenceMetadata(manager, ownedReferences, id);
          }
          return;
        }

        let ast = await parseProgram(code);
        const useServerBoundary = transforms.hasDirective(ast.body, "use server");
        if (!isServer && useServerBoundary) return;

        const normalizedId =
          manager.config.command === "build"
            ? hashString(manager.toRelativeId(id))
            : normalizeViteImportAnalysisUrl(
                manager.server.environments[options.serverEnvironmentName],
                id,
              );

        if (!isServer) {
          for (const definition of active) {
            const inlineDirective = findInlineDirective(ast, definition.directive);
            if (inlineDirective && definition.clientError) {
              throw Object.assign(
                new Error(definition.clientError({ id, environment: this.environment.name })),
                { pos: inlineDirective.start },
              );
            }
          }

          const matches: Array<readonly [ServerFunctionDirective, StringDirective]> = [];
          for (const definition of active) {
            const moduleDirective = findModuleDirective(ast, definition.directive);
            if (moduleDirective) matches.push([definition, moduleDirective]);
          }
          if (matches.length === 0) return;
          if (matches.length > 1) {
            throw Object.assign(
              new Error("Multiple server function directives match this module."),
              {
                pos: matches[1]?.[1].start,
              },
            );
          }

          const match = matches[0];
          if (!match) return;
          const [, moduleDirective] = match;
          const result = transforms.transformDirectiveProxyExport(ast, {
            code,
            directive: moduleDirective.value,
            runtime: (name) =>
              `$$ReactClient.createServerReference(${JSON.stringify(`${normalizedId}#${name}`)},$$ReactClient.callServer,undefined,${this.environment.mode === "dev" ? "$$ReactClient.findSourceMapURL" : "undefined"},${JSON.stringify(name)})`,
          });
          if (!result?.output.hasChanged()) return;
          if (serverReferenceOwnership.get(id) !== false) {
            setOwnedServerReferenceMetadata(
              manager,
              ownedReferences,
              id,
              normalizedId,
              result.exportNames,
            );
          }
          result.output.prepend(
            `${SERVER_FUNCTION_DIRECTIVE_MARKER}\nimport * as $$ReactClient from ${JSON.stringify(this.environment.name === options.browserEnvironmentName ? browserRuntime : ssrRuntime)};\n`,
          );
          return {
            code: result.output.toString(),
            map: result.output.generateMap({ hires: "boundary", source: id }),
          };
        }

        const exportNames = new Set<string>();
        let needsReactRuntime = false;
        let needsEncryptionRuntime = false;
        let outputMap: SourceMap | undefined;

        for (const definition of active) {
          const runtimeName = definition.runtime
            ? `$$server_function_directive_${hashString(definition.runtime)}`
            : undefined;
          let runtimeUsed = false;
          const getRuntime = () => {
            if (runtimeName) runtimeUsed = true;
            return runtimeName;
          };

          let moduleDirective = findModuleDirective(ast, definition.directive);
          if (moduleDirective) {
            if (useServerBoundary) {
              throw Object.assign(
                new Error(
                  `A module cannot contain both ${JSON.stringify(moduleDirective.value)} and "use server" directives.`,
                ),
                { pos: moduleDirective.start },
              );
            }
            const expanded = await expandExportAll(transforms, this, code, ast, id);
            if (expanded) {
              code = expanded.code;
              ast = await parseProgram(code);
              moduleDirective = findModuleDirective(ast, definition.directive);
            }
          }

          const moduleMatch = moduleDirective
            ? matchDirective(moduleDirective.value, definition.directive)
            : undefined;
          if (moduleMatch) {
            definition.validate?.({ id, directive: moduleMatch[0], location: "module" });
          }

          const result = transforms.transformServerActionServer(code, ast, {
            runtime: (value, name) =>
              `$$ReactServer.registerServerReference(${value}, ${JSON.stringify(normalizedId)}, ${JSON.stringify(name)})`,
            directive: definition.directive,
            moduleDirective,
            moduleRuntime: (value, name, meta) => {
              if (!moduleMatch) return value;
              needsReactRuntime = true;
              return `$$ReactServer.registerServerReference(${definition.wrap({ value, name, id, directiveMatch: moduleMatch, location: "module", hasBoundArgs: false, parameters: meta.parameters, runtime: getRuntime(), meta })}, ${JSON.stringify(normalizedId)}, ${JSON.stringify(name)})`;
            },
            inlineRuntime: (value, name, meta) => {
              definition.validate?.({
                id,
                directive: meta.directiveMatch[0],
                location: "inline",
              });
              const wrapped = definition.wrap({
                value,
                name,
                id,
                directiveMatch: meta.directiveMatch,
                location: "inline",
                hasBoundArgs: meta.hasBoundArgs,
                parameters: meta.parameters,
                runtime: getRuntime(),
              });
              if (useServerBoundary) return wrapped;

              needsReactRuntime = true;
              if (meta.hasBoundArgs) {
                needsEncryptionRuntime = true;
                return `$$ReactServer.registerServerReference((($$wrapped) => async ($$encoded, ...$$args) => $$wrapped(...await __vite_rsc_encryption_runtime.decryptActionBoundArgs($$encoded), ...$$args))(${wrapped}), ${JSON.stringify(normalizedId)}, ${JSON.stringify(name)})`;
              }
              return `$$ReactServer.registerServerReference(${wrapped}, ${JSON.stringify(normalizedId)}, ${JSON.stringify(name)})`;
            },
            filter: (name, meta) => definition.filterExport?.({ name, id, meta }) ?? true,
            rejectNonAsyncFunction: definition.rejectNonAsyncFunction,
            rejectNonAsyncModule: definition.rejectNonAsyncModule,
            encode: (value) => {
              needsEncryptionRuntime = true;
              return `__vite_rsc_encryption_runtime.encryptActionBoundArgs(${value})`;
            },
            stableName: true,
            exportWrappedHoist: !useServerBoundary,
            detectUseServerModule: false,
            rejectForbiddenExpressions: true,
          });
          if (!result.output.hasChanged()) continue;

          if (runtimeUsed && definition.runtime && runtimeName) {
            result.output.prepend(
              `import * as ${runtimeName} from ${JSON.stringify(definition.runtime)};\n`,
            );
          }

          const transformedNames = "names" in result ? result.names : result.exportNames;
          transformedNames.forEach((name) => exportNames.add(name));
          outputMap = result.output.generateMap({ hires: "boundary", source: id });
          code = result.output.toString();
          ast = await parseProgram(code);
        }

        if (!useServerBoundary && exportNames.size > 0) {
          serverReferenceOwnership.set(id, true);
          setOwnedServerReferenceMetadata(manager, ownedReferences, id, normalizedId, exportNames);
        } else if (isServer) {
          serverReferenceOwnership.set(id, false);
          removeOwnedServerReferenceMetadata(manager, ownedReferences, id);
        }

        const imports = [
          needsReactRuntime && `import * as $$ReactServer from ${JSON.stringify(rscRuntime)};`,
          needsEncryptionRuntime &&
            `import * as __vite_rsc_encryption_runtime from ${JSON.stringify(encryptionRuntime)};`,
        ].filter(Boolean);
        return {
          code: `${SERVER_FUNCTION_DIRECTIVE_MARKER}\n${imports.join("\n")}\n${code}`,
          map: outputMap,
        };
      },
    },
  };

  const metadataPlugin: Plugin = {
    name: "vinext:server-function-directive-metadata",
    transform: {
      handler(_code, id) {
        if (!manager) return;
        const owned = ownedReferences.get(id);
        if (!owned) return;
        mergeServerReferenceMetadata(manager, id, owned.referenceKey, owned.exportNames);
      },
    },
  };

  return [transformPlugin, metadataPlugin];
}
