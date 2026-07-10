import type { DevEnvironment, Plugin } from "vite";
import type { PluginApi } from "@vitejs/plugin-rsc";
import { toSlash } from "pathslash";

const REFERENCE_VALIDATION_ID_PREFIX = "\0virtual:vite-rsc/reference-validation?";
const SERVER_ACTION_VALIDATION_ID = "virtual:vinext-server-action-validation";
const RESOLVED_SERVER_ACTION_VALIDATION_ID = `\0${SERVER_ACTION_VALIDATION_ID}`;
const RSC_ACTION_SOURCE_SCAN_ID = "virtual:vinext-rsc-action-source-scan";
const RESOLVED_RSC_ACTION_SOURCE_SCAN_ID = `\0${RSC_ACTION_SOURCE_SCAN_ID}`;

type RscPluginWithApi = Plugin & {
  api?: PluginApi;
};

type RscReferenceMeta =
  | PluginApi["manager"]["clientReferenceMetaMap"][string]
  | PluginApi["manager"]["serverReferenceMetaMap"][string];

function parseReferenceValidationQuery(
  id: string,
): { type?: string; id?: string; actionId?: string; hasAny?: string } | null {
  const queryStart = id.indexOf("?");
  if (queryStart === -1) return null;
  return Object.fromEntries(new URLSearchParams(id.slice(queryStart + 1)));
}

function normalizeReferenceKey(id: string): string {
  return id.replaceAll("\0", "__x00__");
}

function hasReference(
  referenceMetaMap: Record<string, RscReferenceMeta> | undefined,
  referenceId: string | undefined,
): boolean {
  if (!referenceMetaMap || !referenceId) return false;

  const normalizedReferenceId = normalizeReferenceKey(referenceId);
  return Object.values(referenceMetaMap).some(
    (meta) => normalizeReferenceKey(meta.referenceKey) === normalizedReferenceId,
  );
}

function hasServerAction(
  referenceMetaMap: Record<string, RscReferenceMeta> | undefined,
  actionId: string | undefined,
): boolean {
  if (!referenceMetaMap || !actionId) return false;
  const separator = actionId.lastIndexOf("#");
  if (separator <= 0 || separator === actionId.length - 1) return false;

  const referenceId = actionId.slice(0, separator);
  const exportName = actionId.slice(separator + 1);
  const normalizedReferenceId = normalizeReferenceKey(referenceId);
  return Object.values(referenceMetaMap).some(
    (meta) =>
      normalizeReferenceKey(meta.referenceKey) === normalizedReferenceId &&
      Array.isArray(meta.exportNames) &&
      meta.exportNames.includes(exportName),
  );
}

function hasAnyServerAction(
  referenceMetaMap: Record<string, RscReferenceMeta> | undefined,
): boolean {
  if (!referenceMetaMap) return false;
  return Object.values(referenceMetaMap).some(
    (meta) => Array.isArray(meta.exportNames) && meta.exportNames.length > 0,
  );
}

async function scanSourceGraph(environment: DevEnvironment, root: string): Promise<void> {
  const pending = [root];
  const visited = new Set<string>();

  while (pending.length > 0) {
    const url = pending.pop()!;
    if (visited.has(url)) continue;
    visited.add(url);

    await environment.transformRequest(url);
    const module = await environment.moduleGraph.getModuleByUrl(url);
    if (!module) continue;

    for (const dependency of module.importedModules) {
      const dependencyId = dependency.id ?? dependency.url;
      if (dependency.type === "js" && !dependencyId.includes("virtual:vite-rsc/")) {
        pending.push(dependency.url);
      }
    }
  }
}

function cleanFileId(id: string): string {
  const queryIndex = id.search(/[?#]/);
  const cleanId = queryIndex === -1 ? id : id.slice(0, queryIndex);
  return toSlash(cleanId.startsWith("/@fs/") ? cleanId.slice("/@fs/".length) : cleanId);
}

function removeDeletedServerReference(
  referenceMetaMap: Record<string, RscReferenceMeta> | undefined,
  file: string,
): void {
  if (!referenceMetaMap) return;
  const deletedFile = cleanFileId(file);
  for (const [id, meta] of Object.entries(referenceMetaMap)) {
    if (cleanFileId(id) === deletedFile || cleanFileId(meta.importId) === deletedFile) {
      delete referenceMetaMap[id];
    }
  }
}

/**
 * @vitejs/plugin-rsc stores dev virtual client-reference keys in Vite's encoded
 * `/@id/__x00__...` form, but React's SSR consumer can ask validation for the
 * decoded `/@id/\0...` form. Treat those as equivalent and fall through to the
 * upstream validator for all other invalid references.
 */
export function createRscReferenceValidationNormalizerPlugin(): Plugin {
  let rscApi: PluginApi | undefined;
  const serverActionValidationModuleIds = new Set<string>();
  const scannedClientReferences = new Set<string>();
  let scannedRscSourceEntry = false;
  let serverActionDiscovery: Promise<void> | undefined;

  async function discoverDevServerActions(): Promise<void> {
    const manager = rscApi?.manager;
    const rscEnvironment = manager?.server?.environments.rsc;
    const ssrEnvironment = manager?.server?.environments.ssr;
    if (!rscEnvironment || !ssrEnvironment) return;

    serverActionDiscovery ??= (async () => {
      // This is the dev equivalent of plugin-RSC's production RSC scan: walk
      // the generated entry's source graph so all route-level client
      // references and direct server references reach the plugin transforms.
      if (!scannedRscSourceEntry) {
        await scanSourceGraph(rscEnvironment, RSC_ACTION_SOURCE_SCAN_ID);
        scannedRscSourceEntry = true;
      }

      // Then mirror the production SSR scan by walking the original source
      // graph behind each client-reference proxy in the SSR environment.
      for (const meta of Object.values(manager.clientReferenceMetaMap)) {
        if (scannedClientReferences.has(meta.importId)) continue;
        await scanSourceGraph(ssrEnvironment, meta.importId);
        scannedClientReferences.add(meta.importId);
      }
    })().finally(() => {
      serverActionDiscovery = undefined;
    });
    await serverActionDiscovery;
  }

  return {
    name: "vinext:rsc-reference-validation-normalizer",
    enforce: "pre",
    apply(_config, env) {
      return env.command === "serve" && env.isPreview !== true;
    },
    configResolved(config) {
      rscApi = (
        config.plugins.find((plugin) => plugin.name === "rsc:minimal") as
          | RscPluginWithApi
          | undefined
      )?.api;
    },
    resolveId: {
      filter: { id: /^virtual:vinext-server-action-validation(?:\?|$)/ },
      handler(id) {
        if (
          id === SERVER_ACTION_VALIDATION_ID ||
          id.startsWith(`${SERVER_ACTION_VALIDATION_ID}?`)
        ) {
          return `\0${id}`;
        }
        return null;
      },
    },
    load: {
      // oxlint-disable-next-line no-control-regex -- null byte prefix is intentional (Vite virtual module convention)
      filter: {
        // oxlint-disable-next-line no-control-regex -- null byte prefix is intentional (Vite virtual module convention)
        id: /^\u0000virtual:(?:vite-rsc\/reference-validation|vinext-server-action-validation)\?/,
      },
      async handler(id) {
        if (id.startsWith(`${RESOLVED_SERVER_ACTION_VALIDATION_ID}?`)) {
          serverActionValidationModuleIds.add(id);
          // The production plugin-RSC scan walks every client-reference graph
          // before it finalizes the server-action manifest. Dev normally waits
          // for the browser to request those modules, which leaves actions
          // imported exclusively behind a client boundary unknown during an
          // unprimed progressive POST. Transform the same client source graph
          // here so plugin-RSC can populate its live metadata without importing
          // or evaluating application modules.
          await discoverDevServerActions();
          const query = parseReferenceValidationQuery(id);
          const valid = query?.hasAny
            ? hasAnyServerAction(rscApi?.manager.serverReferenceMetaMap)
            : hasServerAction(rscApi?.manager.serverReferenceMetaMap, query?.actionId);
          return `export default ${JSON.stringify(valid)};`;
        }
        if (!id.startsWith(REFERENCE_VALIDATION_ID_PREFIX)) return null;

        const query = parseReferenceValidationQuery(id);
        if (!query) return null;

        const manager = rscApi?.manager;
        if (query.type === "client" && hasReference(manager?.clientReferenceMetaMap, query.id)) {
          return "export {}";
        }

        if (query.type === "server" && hasReference(manager?.serverReferenceMetaMap, query.id)) {
          return "export {}";
        }

        return null;
      },
    },
    hotUpdate: {
      order: "post",
      handler(ctx) {
        // plugin-rsc updates its live reference metadata from the RSC transform
        // during the same hot-update pass. Invalidate our result modules after
        // that transform so the next progressive POST reads the current map.
        // These virtual modules cannot express a normal dependency edge: their
        // input is plugin state rather than source imported by the module.
        if (this.environment.name !== "rsc") return;

        // Any changed dependency can alter the action capability of a known
        // client boundary. Re-scan its source graph on the next validation;
        // Vite's module graph keeps unchanged transforms cached.
        scannedRscSourceEntry = false;
        scannedClientReferences.clear();
        const sourceScanModule = this.environment.moduleGraph.getModuleById(
          RESOLVED_RSC_ACTION_SOURCE_SCAN_ID,
        );
        if (sourceScanModule) {
          this.environment.moduleGraph.invalidateModule(
            sourceScanModule,
            new Set(),
            ctx.timestamp,
            true,
          );
        }

        // A deleted module cannot run plugin-rsc's transform again, so its
        // metadata otherwise survives indefinitely and can make a markerless
        // POST look actions-enabled or send stale action ids to module loading.
        if (ctx.type === "delete") {
          removeDeletedServerReference(rscApi?.manager.serverReferenceMetaMap, ctx.file);
        }

        for (const environment of Object.values(ctx.server.environments)) {
          for (const id of serverActionValidationModuleIds) {
            const mod = environment.moduleGraph.getModuleById(id);
            if (mod) {
              environment.moduleGraph.invalidateModule(mod, new Set(), ctx.timestamp, true);
            }
          }
        }
      },
    },
  };
}
