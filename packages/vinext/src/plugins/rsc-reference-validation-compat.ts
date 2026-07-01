import type { Plugin } from "vite";
import type { PluginApi } from "@vitejs/plugin-rsc";

const REFERENCE_VALIDATION_PREFIX = "\0virtual:vite-rsc/reference-validation?";
// oxlint-disable-next-line no-control-regex -- null byte prefix is intentional (Vite virtual module convention)
const REFERENCE_VALIDATION_FILTER = /^\0virtual:vite-rsc\/reference-validation\?/;
const DECODED_RSC_VIRTUAL_PREFIX = "/@id/\0virtual:vite-rsc/";
const ENCODED_RSC_VIRTUAL_PREFIX = "/@id/__x00__virtual:vite-rsc/";

type RscPluginWithApi = Plugin & {
  api?: PluginApi;
};

type ClientReferenceMetaLike = {
  referenceKey: string;
};

type ReferenceValidationRequest = {
  type: string;
  id: string;
};

function parseReferenceValidationRequest(id: string): ReferenceValidationRequest | null {
  if (!id.startsWith(REFERENCE_VALIDATION_PREFIX)) return null;
  const queryIndex = id.indexOf("?");
  if (queryIndex === -1) return null;

  const query = new URLSearchParams(id.slice(queryIndex + 1));
  const type = query.get("type");
  const referenceId = query.get("id");
  return type && referenceId ? { type, id: referenceId } : null;
}

function toEncodedViteRscVirtualReferenceKey(referenceId: string): string | null {
  return referenceId.startsWith(DECODED_RSC_VIRTUAL_PREFIX)
    ? ENCODED_RSC_VIRTUAL_PREFIX + referenceId.slice(DECODED_RSC_VIRTUAL_PREFIX.length)
    : null;
}

export function shouldAcceptDecodedViteRscReferenceValidation(
  referenceId: string,
  clientReferenceMetas: Iterable<ClientReferenceMetaLike>,
): boolean {
  const encodedReferenceKey = toEncodedViteRscVirtualReferenceKey(referenceId);
  if (encodedReferenceKey === null) return false;

  return Array.from(clientReferenceMetas).some((meta) => meta.referenceKey === encodedReferenceKey);
}

export function createRscReferenceValidationCompatPlugin(): Plugin {
  let rscApi: PluginApi | undefined;

  return {
    name: "vinext:rsc-reference-validation-compat",
    enforce: "pre",
    apply: "serve",
    configResolved(config) {
      rscApi = (
        config.plugins.find((plugin) => plugin.name === "rsc:minimal") as
          | RscPluginWithApi
          | undefined
      )?.api;
    },
    load: {
      filter: { id: REFERENCE_VALIDATION_FILTER },
      handler(id) {
        const request = parseReferenceValidationRequest(id);
        if (request?.type !== "client") return null;

        const manager = rscApi?.manager;
        if (!manager) return null;

        // @vitejs/plugin-rsc records dev virtual reference keys after Vite
        // import-analysis escapes the null byte as `__x00__`, while React's
        // SSR validation request can arrive with the decoded null byte. Accept
        // only when the normalized key is already present in plugin-rsc's
        // metadata, preserving the validator's allowlist semantics.
        if (
          shouldAcceptDecodedViteRscReferenceValidation(
            request.id,
            Object.values(manager.clientReferenceMetaMap),
          )
        ) {
          return "export {};";
        }

        return null;
      },
    },
  };
}
