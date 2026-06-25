import fs from "node:fs/promises";
import path from "node:path";
import type { Plugin, ResolvedConfig } from "vite";

export const ACTION_FREE_FLIGHT_SERVER_RUNTIME_ID =
  "virtual:vinext-action-free-flight-server-runtime";

const RESOLVED_ACTION_FREE_FLIGHT_SERVER_RUNTIME_ID = `\0${ACTION_FREE_FLIGHT_SERVER_RUNTIME_ID}`;
const FULL_FLIGHT_SERVER_RUNTIME_ID = "@vitejs/plugin-rsc/vendor/react-server-dom/server.edge";
const FLIGHT_SERVER_PRODUCTION_FILE = "react-server-dom-webpack-server.edge.production.js";
const FLIGHT_SERVER_PRODUCTION_SUFFIXES = [
  `/react-server-dom-webpack/cjs/${FLIGHT_SERVER_PRODUCTION_FILE}`,
  `/@vitejs/plugin-rsc/dist/vendor/react-server-dom/cjs/${FLIGHT_SERVER_PRODUCTION_FILE}`,
];
const FLIGHT_BROWSER_PRODUCTION_FILE = "react-server-dom-webpack-client.browser.production.js";
const FLIGHT_BROWSER_PRODUCTION_SUFFIXES = [
  `/react-server-dom-webpack/cjs/${FLIGHT_BROWSER_PRODUCTION_FILE}`,
  `/@vitejs/plugin-rsc/dist/vendor/react-server-dom/cjs/${FLIGHT_BROWSER_PRODUCTION_FILE}`,
];
const FLIGHT_SSR_PRODUCTION_FILE = "react-server-dom-webpack-client.edge.production.js";
const FLIGHT_SSR_PRODUCTION_SUFFIXES = [
  `/react-server-dom-webpack/cjs/${FLIGHT_SSR_PRODUCTION_FILE}`,
  `/@vitejs/plugin-rsc/dist/vendor/react-server-dom/cjs/${FLIGHT_SSR_PRODUCTION_FILE}`,
];
const DECODER_START = "function resolveServerReference(bundlerConfig, id) {";
const RENDER_EXPORTS_START = "exports.registerClientReference = function (";
const SERVER_REFERENCE_EXPORT_START = "exports.registerServerReference = function (";
const STREAM_RENDER_EXPORT_START = "exports.renderToReadableStream = function (";
const CLIENT_ACTION_RUNTIME_START = "function getIteratorFn(";
const CLIENT_DECODE_RUNTIME_START = "function ReactPromise(";
const CLIENT_SERVER_REFERENCE_LOADER_START = "function loadServerReference(";
const CLIENT_OUTLINED_MODEL_START = "function getOutlinedModel(";
const CLIENT_EXPORTS_START = "exports.createFromFetch = function (";
const CLIENT_SERVER_REFERENCE_EXPORT_START = "exports.createServerReference = function (";
const TEMPORARY_REFERENCE_RUNTIME_START =
  ',\n  TEMPORARY_REFERENCE_TAG = Symbol.for("react.temporary.reference"),';
const TEMPORARY_REFERENCE_RUNTIME_END = "function noop() {}";
const TEMPORARY_REFERENCE_OBJECT_BRANCH_START =
  "if (\n      void 0 !== request.temporaryReferences &&";
const TEMPORARY_REFERENCE_OBJECT_BRANCH_END = 'return "$T" + elementReference;';
const TEMPORARY_REFERENCE_COMPONENT_CHECK =
  '    "function" === typeof type &&\n' +
  "    type.$$typeof !== CLIENT_REFERENCE_TAG$1 &&\n" +
  "    type.$$typeof !== TEMPORARY_REFERENCE_TAG";
const SERVER_REFERENCE_VALUE_BRANCH_START = "if (value.$$typeof === SERVER_REFERENCE_TAG)";
const SERVER_REFERENCE_VALUE_BRANCH_END = "if (/^on[A-Z]/.test(parentPropertyName))";
const SERVER_REFERENCE_BIND_RUNTIME_START = "var FunctionBind = Function.prototype.bind,";
const SERVER_REFERENCE_BIND_RUNTIME_END = "  PROMISE_PROTOTYPE = Promise.prototype,";
const SERVER_REFERENCE_TAG_DECLARATION =
  'var CLIENT_REFERENCE_TAG$1 = Symbol.for("react.client.reference"),\n' +
  '  SERVER_REFERENCE_TAG = Symbol.for("react.server.reference");';
const REQUEST_TEMPORARY_REFERENCE_PARAMETER = "  identifierPrefix,\n  temporaryReferences\n) {";
const RENDER_TEMPORARY_REFERENCE_ARGUMENT =
  "    options ? options.identifierPrefix : void 0,\n" +
  "    options ? options.temporaryReferences : void 0";
const COMMONJS_IMPORTS_RE =
  /["']use strict["'];\s*var ReactDOM = require\(["']react-dom["']\),\s*React = require\(["']react["']\),\s*/;
const CLIENT_COMMONJS_IMPORTS_RE =
  /["']use strict["'];\s*var ReactDOM = require\(["']react-dom["']\),\s*/;
const CLIENT_MANIFEST_SOURCE = `
export function createClientManifest() {
  return new Proxy({}, {
    get(_target, referenceId) {
      if (typeof referenceId !== "string") {
        throw new TypeError("Expected a string React client reference id");
      }
      const [id, name] = referenceId.split("#");
      if (!id || !name) {
        throw new TypeError("Expected a React client reference id with an export name");
      }
      return {
        id,
        name,
        chunks: [],
        async: true,
      };
    },
  });
}
`;

function hasRuntimeSuffix(id: string, suffixes: readonly string[]): boolean {
  return suffixes.some((suffix) => id.endsWith(suffix));
}

function fallbackRuntimeSource(): string {
  return `${CLIENT_MANIFEST_SOURCE}
export { registerClientReference, renderToReadableStream } from ${JSON.stringify(
    FULL_FLIGHT_SERVER_RUNTIME_ID,
  )};`;
}

function replaceRequired(source: string, search: string, replacement: string): string | null {
  const index = source.indexOf(search);
  if (index < 0 || source.indexOf(search, index + search.length) >= 0) return null;
  return source.slice(0, index) + replacement + source.slice(index + search.length);
}

function replaceRequiredRange(
  source: string,
  startMarker: string,
  endMarker: string,
  replacement: string,
  includeEndMarker = false,
): string | null {
  const start = source.indexOf(startMarker);
  if (start < 0) return null;
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end < 0) return null;
  const endOffset = includeEndMarker ? end + endMarker.length : end;
  return source.slice(0, start) + replacement + source.slice(endOffset);
}

/**
 * Action-free entries never create temporary references or register server
 * references. Remove those serializer branches from React's render-only
 * runtime while preserving the complete runtime when source markers change.
 */
export function pruneActionFreeFlightReferenceSerialization(source: string): string | null {
  let result = replaceRequired(
    source,
    SERVER_REFERENCE_TAG_DECLARATION,
    'var CLIENT_REFERENCE_TAG$1 = Symbol.for("react.client.reference");',
  );
  if (result === null) return null;

  result = replaceRequiredRange(
    result,
    SERVER_REFERENCE_BIND_RUNTIME_START,
    SERVER_REFERENCE_BIND_RUNTIME_END,
    "var PROMISE_PROTOTYPE = Promise.prototype,",
    true,
  );
  if (result === null) return null;

  result = replaceRequiredRange(
    result,
    TEMPORARY_REFERENCE_RUNTIME_START,
    TEMPORARY_REFERENCE_RUNTIME_END,
    ";\nfunction noop() {}",
    true,
  );
  if (result === null) return null;

  result = replaceRequiredRange(
    result,
    TEMPORARY_REFERENCE_OBJECT_BRANCH_START,
    TEMPORARY_REFERENCE_OBJECT_BRANCH_END,
    "",
    true,
  );
  if (result === null) return null;

  result = replaceRequiredRange(
    result,
    SERVER_REFERENCE_VALUE_BRANCH_START,
    SERVER_REFERENCE_VALUE_BRANCH_END,
    "",
  );
  if (result === null) return null;

  for (const [search, replacement] of [
    [
      TEMPORARY_REFERENCE_COMPONENT_CHECK,
      '    "function" === typeof type && type.$$typeof !== CLIENT_REFERENCE_TAG$1',
    ],
    [REQUEST_TEMPORARY_REFERENCE_PARAMETER, "  identifierPrefix\n) {"],
    [RENDER_TEMPORARY_REFERENCE_ARGUMENT, "    options ? options.identifierPrefix : void 0"],
    ["  this.writtenServerReferences = new Map();\n", ""],
    ["  this.temporaryReferences = temporaryReferences;\n", ""],
    ["  this.taintCleanupQueue = [];\n", ""],
  ] as const) {
    result = replaceRequired(result, search, replacement);
    if (result === null) return null;
  }

  if (
    result.includes("temporaryReferences") ||
    result.includes("SERVER_REFERENCE_TAG") ||
    result.includes("TEMPORARY_REFERENCE_TAG") ||
    result.includes("writtenServerReferences")
  ) {
    return null;
  }
  return result;
}

/**
 * Convert React Flight's production server bundle into an ESM render-only
 * runtime. React currently places its renderer and action decoder in one
 * CommonJS file, which prevents bundlers from dropping the decoder.
 *
 * The markers deliberately fail closed. A React release that changes this
 * source shape keeps the complete upstream runtime instead.
 */
export function createActionFreeFlightServerRuntimeSource(code: string): string | null {
  const decoderStart = code.indexOf(DECODER_START);
  const renderExportsStart = code.indexOf(RENDER_EXPORTS_START, decoderStart);
  const serverReferenceExportStart = code.indexOf(
    SERVER_REFERENCE_EXPORT_START,
    renderExportsStart,
  );
  const streamRenderExportStart = code.indexOf(
    STREAM_RENDER_EXPORT_START,
    serverReferenceExportStart,
  );
  if (
    decoderStart < 0 ||
    renderExportsStart < 0 ||
    serverReferenceExportStart < 0 ||
    streamRenderExportStart < 0
  ) {
    return null;
  }
  const rendererSource = code.slice(0, decoderStart);
  if (
    !rendererSource.includes("function RequestInstance(") ||
    !rendererSource.includes("function startWork(") ||
    !rendererSource.includes("function startFlowing(") ||
    !rendererSource.includes("function abort(")
  ) {
    return null;
  }

  let result =
    rendererSource +
    code.slice(renderExportsStart, serverReferenceExportStart) +
    code.slice(streamRenderExportStart);
  result = pruneActionFreeFlightReferenceSerialization(result) ?? result;
  result = result.replace(
    COMMONJS_IMPORTS_RE,
    'import * as ReactDOM from "react-dom";\nimport * as React from "react";\nvar ',
  );

  for (const exportName of ["registerClientReference", "renderToReadableStream"]) {
    result = result.replace(
      `exports.${exportName} = function (`,
      `export const ${exportName} = function (`,
    );
  }

  if (
    result.includes("require(") ||
    /^\s*exports\./m.test(result) ||
    !result.includes("export const registerClientReference = function (") ||
    !result.includes("export const renderToReadableStream = function (")
  ) {
    return null;
  }

  return result + CLIENT_MANIFEST_SOURCE;
}

function createUnexpectedServerReferenceSource(): string {
  return `function loadServerReference() {
  throw new Error("Unexpected server reference in an action-free React Flight payload.");
}
`;
}

function createActionFreeClientExportsSource(): string {
  return `
export function createServerReference() {
  throw new Error("Cannot create a server reference in an action-free React Flight build.");
}
export function createTemporaryReferenceSet() {
  return new Map();
}
export function encodeReply() {
  throw new Error("Cannot encode a server reply in an action-free React Flight build.");
}
`;
}

/**
 * Convert React Flight's production client bundle into an ESM decode-only
 * runtime. Action-free builds cannot receive or invoke server references, so
 * reply encoding and server-reference binding are unreachable.
 */
export function createActionFreeFlightClientRuntimeSource(code: string): string | null {
  const actionRuntimeStart = code.indexOf(CLIENT_ACTION_RUNTIME_START);
  const decodeRuntimeStart = code.indexOf(CLIENT_DECODE_RUNTIME_START, actionRuntimeStart);
  const serverReferenceLoaderStart = code.indexOf(
    CLIENT_SERVER_REFERENCE_LOADER_START,
    decodeRuntimeStart,
  );
  const outlinedModelStart = code.indexOf(CLIENT_OUTLINED_MODEL_START, serverReferenceLoaderStart);
  const exportsStart = code.indexOf(CLIENT_EXPORTS_START, outlinedModelStart);
  const serverReferenceExportStart = code.indexOf(
    CLIENT_SERVER_REFERENCE_EXPORT_START,
    exportsStart,
  );
  if (
    actionRuntimeStart < 0 ||
    decodeRuntimeStart < 0 ||
    serverReferenceLoaderStart < 0 ||
    outlinedModelStart < 0 ||
    exportsStart < 0 ||
    serverReferenceExportStart < 0
  ) {
    return null;
  }

  let result =
    code.slice(0, actionRuntimeStart) +
    "var ASYNC_ITERATOR = Symbol.asyncIterator;\n" +
    code.slice(decodeRuntimeStart, serverReferenceLoaderStart) +
    createUnexpectedServerReferenceSource() +
    code.slice(outlinedModelStart, exportsStart) +
    code.slice(exportsStart, serverReferenceExportStart);
  result = result.replace(
    CLIENT_COMMONJS_IMPORTS_RE,
    'import * as ReactDOM from "react-dom";\nvar ',
  );
  result = result.replace(
    "exports.createFromFetch = function (",
    "export const createFromFetch = function (",
  );
  result = result.replace(
    "exports.createFromReadableStream = function (",
    "export const createFromReadableStream = function (",
  );
  result += createActionFreeClientExportsSource();

  if (
    /\brequire\(["']/.test(result) ||
    /^\s*exports\./m.test(result) ||
    !result.includes("export const createFromFetch = function (") ||
    !result.includes("export const createFromReadableStream = function (") ||
    !result.includes("Unexpected server reference in an action-free React Flight payload.")
  ) {
    return null;
  }

  return result;
}

type ActionFreeFlightRuntimePluginOptions = {
  useActionFreeFlightClientRuntime?: (
    config: Pick<ResolvedConfig, "command" | "plugins">,
  ) => boolean | Promise<boolean>;
};

export function createActionFreeFlightServerRuntimePlugin(
  pluginOptions: ActionFreeFlightRuntimePluginOptions = {},
): Plugin {
  let serverRuntimeSourcePath: string | null = null;

  return {
    name: "vinext:action-free-flight-server-runtime",
    enforce: "pre",
    async resolveId(source, importer, resolveOptions) {
      const resolveRuntimeSourcePath = async (
        runtimeId: string,
        productionFile: string,
      ): Promise<string | null> => {
        const resolved = await this.resolve(runtimeId, importer, {
          ...resolveOptions,
          skipSelf: true,
        });
        if (!resolved || (resolved.external !== undefined && resolved.external !== false)) {
          return null;
        }
        return path.join(path.dirname(resolved.id.split("?", 1)[0]), "cjs", productionFile);
      };

      if (source === ACTION_FREE_FLIGHT_SERVER_RUNTIME_ID) {
        serverRuntimeSourcePath = await resolveRuntimeSourcePath(
          FULL_FLIGHT_SERVER_RUNTIME_ID,
          FLIGHT_SERVER_PRODUCTION_FILE,
        );
        return RESOLVED_ACTION_FREE_FLIGHT_SERVER_RUNTIME_ID;
      }
      return null;
    },
    async load(id) {
      if (id !== RESOLVED_ACTION_FREE_FLIGHT_SERVER_RUNTIME_ID) return null;
      if (!serverRuntimeSourcePath) return fallbackRuntimeSource();

      try {
        const code = await fs.readFile(serverRuntimeSourcePath, "utf8");
        if (
          !hasRuntimeSuffix(
            serverRuntimeSourcePath.replaceAll("\\", "/"),
            FLIGHT_SERVER_PRODUCTION_SUFFIXES,
          )
        ) {
          return fallbackRuntimeSource();
        }
        return createActionFreeFlightServerRuntimeSource(code) ?? fallbackRuntimeSource();
      } catch {
        return fallbackRuntimeSource();
      }
    },
    async transform(code, id) {
      const cleanId = id.replaceAll("\\", "/").split("?", 1)[0];
      if (
        !hasRuntimeSuffix(cleanId, FLIGHT_BROWSER_PRODUCTION_SUFFIXES) &&
        !hasRuntimeSuffix(cleanId, FLIGHT_SSR_PRODUCTION_SUFFIXES)
      ) {
        return null;
      }
      if (!(await pluginOptions.useActionFreeFlightClientRuntime?.(this.environment.config))) {
        return null;
      }

      const result = createActionFreeFlightClientRuntimeSource(code);
      return result === null ? null : { code: result, map: null };
    },
  };
}
