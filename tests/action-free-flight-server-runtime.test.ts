import { describe, expect, it } from "vite-plus/test";
import {
  createActionFreeFlightClientRuntimeSource,
  createActionFreeFlightServerRuntimeSource,
} from "../packages/vinext/src/plugins/action-free-flight-server-runtime.js";

const flightSource = `/**
 * @license React
 */

"use strict";
var ReactDOM = require("react-dom"),
  React = require("react"),
  SHARED = React.shared;
function renderModel() {
  return ReactDOM.render(SHARED);
}
function RequestInstance() {}
function startWork() {}
function startFlowing() {}
function abort() {}
function resolveServerReference(bundlerConfig, id) {
  return bundlerConfig[id];
}
function decodeReply(body) {
  return resolveServerReference(body, "id");
}
exports.createClientModuleProxy = function (moduleId) {
  return moduleId;
};
exports.decodeReply = function (body) {
  return decodeReply(body);
};
exports.prerender = function (model) {
  return model;
};
exports.registerClientReference = function (reference) {
  return reference;
};
exports.registerServerReference = function (reference) {
  return reference;
};
exports.renderToReadableStream = function (model) {
  return renderModel(model);
};
`;

describe("action-free Flight server runtime", () => {
  it("keeps renderer exports while removing the action decoder", () => {
    const result = createActionFreeFlightServerRuntimeSource(flightSource);

    expect(result).toContain('import * as ReactDOM from "react-dom"');
    expect(result).toContain('import * as React from "react"');
    expect(result).toContain("export const registerClientReference = function (");
    expect(result).toContain("export const renderToReadableStream = function (");
    expect(result).toContain("export function createClientManifest()");
    expect(result).not.toContain("resolveServerReference");
    expect(result).not.toContain("decodeReply");
    expect(result).not.toContain("createClientModuleProxy");
    expect(result).not.toContain("prerender");
    expect(result).not.toContain("require(");
    expect(result).not.toContain("exports.");
  });

  it("matches plugin-rsc client manifest parsing", () => {
    const result = createActionFreeFlightServerRuntimeSource(flightSource);

    expect(result).toContain('const [id, name] = referenceId.split("#")');
    expect(result).toContain("if (!id || !name)");
    expect(result).toContain("id,");
    expect(result).toContain("name,");
  });

  it("falls back when React changes the expected source shape", () => {
    expect(createActionFreeFlightServerRuntimeSource("export function render() {}")).toBeNull();
  });
});

const flightClientSource = `/**
 * @license React
 */

"use strict";
var ReactDOM = require("react-dom"),
  decoderOptions = { stream: true };
function resolveClientReference(config, metadata) {
  return config[metadata];
}
function getIteratorFn(value) {
  return value[Symbol.iterator];
}
var ASYNC_ITERATOR = Symbol.asyncIterator,
  knownServerReferences = new WeakMap();
function processReply(value) {
  return knownServerReferences.get(value);
}
function registerBoundServerReference(reference) {
  knownServerReferences.set(reference, true);
}
function createBoundServerReference() {
  return function action() {};
}
function ReactPromise(status, value) {
  this.status = status;
  this.value = value;
}
function loadServerReference() {
  return createBoundServerReference();
}
function getOutlinedModel(response, reference, parentObject, key, map) {
  return map(response, reference, parentObject, key);
}
function createResponseFromOptions(options) {
  return { decoderOptions, options };
}
exports.createFromFetch = function (response, options) {
  return createResponseFromOptions(options);
};
exports.createFromReadableStream = function (stream, options) {
  return resolveClientReference(createResponseFromOptions(options), stream);
};
exports.createServerReference = function () {
  return createBoundServerReference();
};
exports.createTemporaryReferenceSet = function () {
  return new Map();
};
exports.encodeReply = function (value) {
  return processReply(value);
};
`;

describe("action-free Flight client runtime", () => {
  it("keeps response decoding while removing reply encoding and server-reference binding", () => {
    const result = createActionFreeFlightClientRuntimeSource(flightClientSource);

    expect(result).toContain('import * as ReactDOM from "react-dom"');
    expect(result).toContain("export const createFromFetch = function (");
    expect(result).toContain("export const createFromReadableStream = function (");
    expect(result).toContain("Unexpected server reference in an action-free React Flight payload.");
    expect(result).not.toContain("processReply");
    expect(result).not.toContain("knownServerReferences");
    expect(result).not.toContain("registerBoundServerReference");
    expect(result).not.toContain("createBoundServerReference");
    expect(result).not.toContain("require(");
    expect(result).not.toContain("exports.");
  });

  it("retains the vendor export surface with guarded action-only stubs", () => {
    const result = createActionFreeFlightClientRuntimeSource(flightClientSource);

    expect(result).toContain("export function createServerReference()");
    expect(result).toContain("export function createTemporaryReferenceSet()");
    expect(result).toContain("export function encodeReply()");
  });

  it("falls back when React changes the expected client source shape", () => {
    expect(createActionFreeFlightClientRuntimeSource("export function decode() {}")).toBeNull();
  });
});
