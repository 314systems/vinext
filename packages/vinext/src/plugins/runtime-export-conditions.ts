import { builtinModules } from "node:module";
import { createIdResolver, type Plugin, type ResolvedConfig, type Rollup } from "vite";

export type RuntimeExportCondition = "edge-light" | "edge-light-react-server" | "middleware";

const RUNTIME_CONDITION_QUERY = "__vinext_runtime_condition";
const RUNTIME_VIRTUAL_PREFIX = "\0vinext-runtime-virtual:";
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

function isVirtualId(specifier: string): boolean {
  return specifier.startsWith("virtual:") || specifier.startsWith("\0virtual:");
}

function isUnhandledScheme(specifier: string): boolean {
  const schemeSpecifier = specifier.startsWith("\0") ? specifier.slice(1) : specifier;
  return /^[a-z][a-z+.-]*:/.test(schemeSpecifier) && !isVirtualId(specifier);
}

type ResolvedId = Rollup.PartialResolvedId;

function normalizeResolvedId(resolved: string | ResolvedId): ResolvedId {
  return typeof resolved === "string" ? { id: resolved } : resolved;
}

type VirtualProfile = RuntimeExportCondition | "default";

type VirtualProxy = {
  originalId: string;
  profile: VirtualProfile;
};

type VirtualEnvironmentState = {
  loadResults: Map<string, Promise<Rollup.LoadResult | null>>;
  proxies: Map<string, VirtualProxy>;
  proxyIds: Map<string, string>;
};

function virtualProxyKey(originalId: string, profile: VirtualProfile): string {
  return `${profile}\0${originalId}`;
}

function getLoadHandler(
  plugin: Plugin,
): Plugin["load"] extends infer Hook
  ? Hook extends { handler: infer Handler }
    ? Handler
    : Hook
  : never {
  const hook = plugin.load;
  return (typeof hook === "object" && hook !== null ? hook.handler : hook) as never;
}

function isViteCorePlugin(plugin: Plugin): boolean {
  return plugin.name.startsWith("vite:") || plugin.name.startsWith("builtin:vite-");
}

type LoadIdFilter =
  | string
  | RegExp
  | LoadIdFilter[]
  | { include?: LoadIdFilter; exclude?: LoadIdFilter };

function matchesLoadIdFilter(filter: LoadIdFilter | undefined, id: string): boolean {
  if (filter === undefined) return true;
  if (typeof filter === "string") return id === filter;
  if (filter instanceof RegExp) {
    filter.lastIndex = 0;
    return filter.test(id);
  }
  if (Array.isArray(filter)) return filter.some((entry) => matchesLoadIdFilter(entry, id));
  if (filter.exclude && matchesLoadIdFilter(filter.exclude, id)) return false;
  return filter.include === undefined || matchesLoadIdFilter(filter.include, id);
}

function loadHookMatches(plugin: Plugin, id: string): boolean {
  const hook = plugin.load;
  if (typeof hook !== "object" || hook === null || !("filter" in hook)) return true;
  return matchesLoadIdFilter(hook.filter?.id as LoadIdFilter | undefined, id);
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
  const virtualStates = new WeakMap<object, VirtualEnvironmentState>();
  let virtualProxyIndex = 0;

  const plugin: Plugin = {
    name: "vinext:runtime-export-conditions",
    enforce: "pre",

    configResolved(resolvedConfig) {
      config = resolvedConfig;
    },

    buildStart() {
      virtualStates.get(this.environment)?.loadResults.clear();
    },

    async resolveId(source, importer, options) {
      const environment = this.environment;
      let virtualState = virtualStates.get(environment);
      if (!virtualState) {
        virtualState = {
          loadResults: new Map(),
          proxies: new Map(),
          proxyIds: new Map(),
        };
        virtualStates.set(environment, virtualState);
      }
      const importerProfile = importer ? virtualState.proxies.get(importer)?.profile : undefined;
      const condition =
        readRuntimeExportCondition(source) ??
        readRuntimeExportCondition(importer) ??
        (importerProfile === "default" ? null : importerProfile) ??
        null;

      const cleanSource = stripRuntimeExportCondition(source);
      if (NODE_BUILTINS.has(cleanSource) || isUnhandledScheme(cleanSource)) return null;

      const cleanImporter = importer ? stripRuntimeExportCondition(importer) : undefined;
      if (condition === null) {
        const pluginResolved = await this.resolve(cleanSource, cleanImporter, {
          ...options,
          skipSelf: true,
        });
        if (!pluginResolved || pluginResolved.external || !isVirtualId(pluginResolved.id)) {
          return null;
        }
        const key = virtualProxyKey(pluginResolved.id, "default");
        let proxyId = virtualState.proxyIds.get(key);
        if (!proxyId) {
          proxyId = `${RUNTIME_VIRTUAL_PREFIX}${virtualProxyIndex++}`;
          virtualState.proxyIds.set(key, proxyId);
          virtualState.proxies.set(proxyId, {
            originalId: pluginResolved.id,
            profile: "default",
          });
        }
        return { ...pluginResolved, id: proxyId };
      }

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
      const customResolved = await resolver(environment, cleanSource, cleanImporter);
      const pluginResolved = await this.resolve(cleanSource, cleanImporter, {
        ...options,
        skipSelf: true,
      });
      if (!customResolved && !pluginResolved) return null;

      const resolved = normalizeResolvedId(customResolved ?? pluginResolved!);
      const metadata = pluginResolved ? { ...pluginResolved, ...resolved } : resolved;
      if (metadata.external) return metadata;

      const resolvedId = resolved.id;
      if (isVirtualId(resolvedId)) {
        const key = virtualProxyKey(resolvedId, condition);
        let proxyId = virtualState.proxyIds.get(key);
        if (!proxyId) {
          proxyId = `${RUNTIME_VIRTUAL_PREFIX}${virtualProxyIndex++}`;
          virtualState.proxyIds.set(key, proxyId);
          virtualState.proxies.set(proxyId, { originalId: resolvedId, profile: condition });
        }
        return { ...metadata, id: proxyId };
      }
      if (
        !resolvedId.startsWith("\0") &&
        !resolvedId.startsWith("/") &&
        !/^[A-Za-z]:[\\/]/.test(resolvedId)
      ) {
        return metadata;
      }

      return {
        ...metadata,
        id: withRuntimeExportCondition(resolvedId, condition),
      };
    },

    async load(id, options) {
      if (!id.startsWith(RUNTIME_VIRTUAL_PREFIX)) return null;
      const virtualState = virtualStates.get(this.environment);
      const proxy = virtualState?.proxies.get(id);
      if (!virtualState || !proxy) return null;

      let loadResult = virtualState.loadResults.get(proxy.originalId);
      if (!loadResult) {
        loadResult = (async () => {
          for (const candidate of this.environment.config.plugins) {
            if (candidate === plugin || isViteCorePlugin(candidate)) continue;
            if (!loadHookMatches(candidate, proxy.originalId)) continue;
            const handler = getLoadHandler(candidate);
            if (typeof handler !== "function") continue;
            const result = await handler.call(this, proxy.originalId, options);
            if (result != null) return result;
          }
          return null;
        })();
        virtualState.loadResults.set(proxy.originalId, loadResult);
      }
      return loadResult;
    },
  };

  return plugin;
}
