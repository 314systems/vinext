import { describe, expect, it } from "vite-plus/test";
import { createActionFreeFlightServerRuntimeSource } from "../packages/vinext/src/plugins/action-free-flight-server-runtime.js";

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
