import { builtinModules } from "node:module";
import { createIdResolver, type Plugin, type ResolvedConfig } from "vite";

export type RuntimeExportCondition = "edge-light" | "edge-light-react-server" | "middleware";

const RUNTIME_CONDITION_QUERY = "__vinext_runtime_condition";
const NODE_BUILTINS = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);

export function withRuntimeExportCondition(
  specifier: string,
  condition: RuntimeExportCondition,
): string {
  const separator = specifier.includes("?") ? "&" : "?";
  return `${specifier}${separator}${RUNTIME_CONDITION_QUERY}=${condition}`;
}

function readRuntimeExportCondition(specifier: string | undefined): RuntimeExportCondition | null {
  if (!specifier) return null;
  const queryIndex = specifier.indexOf("?");
  if (queryIndex === -1) return null;
  const value = new URLSearchParams(specifier.slice(queryIndex + 1)).get(RUNTIME_CONDITION_QUERY);
  return value === "edge-light" || value === "edge-light-react-server" || value === "middleware"
    ? value
    : null;
}

function stripRuntimeExportCondition(specifier: string): string {
  const queryIndex = specifier.indexOf("?");
  if (queryIndex === -1) return specifier;

  const pathname = specifier.slice(0, queryIndex);
  const params = new URLSearchParams(specifier.slice(queryIndex + 1));
  params.delete(RUNTIME_CONDITION_QUERY);
  const query = params.toString();
  return query.length > 0 ? `${pathname}?${query}` : pathname;
}

function runtimeConditions(
  config: ResolvedConfig,
  environmentConditions: readonly string[],
  condition: RuntimeExportCondition,
): string[] {
  const conditions = new Set<string>();
  if (condition !== "edge-light") conditions.add("react-server");
  conditions.add("edge-light");
  conditions.add("browser");

  for (const value of environmentConditions) {
    if (value !== "worker" && value !== "workerd" && value !== "node" && value !== "node-addons") {
      conditions.add(value);
    }
  }

  if (config.isProduction) conditions.add("production");
  else conditions.add("development");
  return [...conditions];
}

export function runtimeExportConditionsPlugin(): Plugin {
  let config: ResolvedConfig;
  const resolvers = new Map<string, ReturnType<typeof createIdResolver>>();

  return {
    name: "vinext:runtime-export-conditions",
    enforce: "pre",

    configResolved(resolvedConfig) {
      config = resolvedConfig;
    },

    async resolveId(source, importer, options) {
      const condition = readRuntimeExportCondition(source) ?? readRuntimeExportCondition(importer);
      if (condition === null) return null;

      const cleanSource = stripRuntimeExportCondition(source);
      if (NODE_BUILTINS.has(cleanSource) || /^[a-z][a-z+.-]*:/.test(cleanSource)) return null;

      const cleanImporter = importer ? stripRuntimeExportCondition(importer) : undefined;
      const environment = this.environment;
      const conditions = runtimeConditions(
        config,
        environment.config.resolve.conditions,
        condition,
      );
      const isRequire = options.kind === "require-call";
      const resolverKey = `${condition}:${isRequire ? "require" : "import"}:${conditions.join("\0")}`;
      let resolver = resolvers.get(resolverKey);
      if (!resolver) {
        resolver = createIdResolver(config, { conditions, isRequire });
        resolvers.set(resolverKey, resolver);
      }
      const resolved = await resolver(environment, cleanSource, cleanImporter);
      if (!resolved) return null;
      if (
        !resolved.startsWith("\0") &&
        !resolved.startsWith("/") &&
        !/^[A-Za-z]:[\\/]/.test(resolved)
      ) {
        return resolved;
      }

      return withRuntimeExportCondition(resolved, condition);
    },
  };
}
