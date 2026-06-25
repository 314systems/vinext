import fs from "node:fs/promises";
import path from "node:path";
import type { Plugin } from "vite";

export const ACTION_FREE_FLIGHT_SERVER_RUNTIME_ID =
  "virtual:vinext-action-free-flight-server-runtime";

const RESOLVED_ACTION_FREE_FLIGHT_SERVER_RUNTIME_ID = `\0${ACTION_FREE_FLIGHT_SERVER_RUNTIME_ID}`;
const FULL_FLIGHT_SERVER_RUNTIME_ID = "@vitejs/plugin-rsc/vendor/react-server-dom/server.edge";
const FLIGHT_SERVER_PRODUCTION_FILE = "react-server-dom-webpack-server.edge.production.js";
const FLIGHT_SERVER_PRODUCTION_SUFFIX = `/react-server-dom-webpack/cjs/${FLIGHT_SERVER_PRODUCTION_FILE}`;
const DECODER_START = "function resolveServerReference(bundlerConfig, id) {";
const RENDER_EXPORTS_START = "exports.registerClientReference = function (";
const SERVER_REFERENCE_EXPORT_START = "exports.registerServerReference = function (";
const STREAM_RENDER_EXPORT_START = "exports.renderToReadableStream = function (";
const COMMONJS_IMPORTS_RE =
  /["']use strict["'];\s*var ReactDOM = require\(["']react-dom["']\),\s*React = require\(["']react["']\),\s*/;
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

function fallbackRuntimeSource(): string {
  return `${CLIENT_MANIFEST_SOURCE}
export { registerClientReference, renderToReadableStream } from ${JSON.stringify(
    FULL_FLIGHT_SERVER_RUNTIME_ID,
  )};`;
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

export function createActionFreeFlightServerRuntimePlugin(): Plugin {
  let runtimeSourcePath: string | null = null;

  return {
    name: "vinext:action-free-flight-server-runtime",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (source !== ACTION_FREE_FLIGHT_SERVER_RUNTIME_ID) return null;

      const resolved = await this.resolve(FULL_FLIGHT_SERVER_RUNTIME_ID, importer, {
        ...options,
        skipSelf: true,
      });
      if (resolved && (resolved.external === undefined || resolved.external === false)) {
        const cleanId = resolved.id.split("?", 1)[0];
        runtimeSourcePath = path.join(path.dirname(cleanId), "cjs", FLIGHT_SERVER_PRODUCTION_FILE);
      }

      return RESOLVED_ACTION_FREE_FLIGHT_SERVER_RUNTIME_ID;
    },
    async load(id) {
      if (id !== RESOLVED_ACTION_FREE_FLIGHT_SERVER_RUNTIME_ID) return null;
      if (!runtimeSourcePath) return fallbackRuntimeSource();

      try {
        const code = await fs.readFile(runtimeSourcePath, "utf8");
        if (!runtimeSourcePath.replaceAll("\\", "/").endsWith(FLIGHT_SERVER_PRODUCTION_SUFFIX)) {
          return fallbackRuntimeSource();
        }
        return createActionFreeFlightServerRuntimeSource(code) ?? fallbackRuntimeSource();
      } catch {
        return fallbackRuntimeSource();
      }
    },
  };
}
