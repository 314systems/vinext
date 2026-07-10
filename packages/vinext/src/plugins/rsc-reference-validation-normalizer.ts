import type { Plugin } from "vite";
import type { PluginApi } from "@vitejs/plugin-rsc";
import { toSlash } from "pathslash";

const REFERENCE_VALIDATION_ID_PREFIX = "\0virtual:vite-rsc/reference-validation?";
const SERVER_ACTION_VALIDATION_ID = "virtual:vinext-server-action-validation";
const RESOLVED_SERVER_ACTION_VALIDATION_ID = `\0${SERVER_ACTION_VALIDATION_ID}`;

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
      handler(id) {
        if (id.startsWith(`${RESOLVED_SERVER_ACTION_VALIDATION_ID}?`)) {
          serverActionValidationModuleIds.add(id);
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
