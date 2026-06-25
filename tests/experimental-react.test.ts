import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  createExperimentalReactEnvironmentAliases,
  needsExperimentalReact,
  resolveExperimentalReactAliases,
  resolveExperimentalReactSpecifier,
} from "../packages/vinext/src/config/experimental-react.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("experimental React channel", () => {
  it.each([
    [undefined, false],
    [{}, false],
    [{ taint: true }, true],
    [{ transitionIndicator: true }, true],
    [{ gestureTransition: true }, true],
    [{ useExperimentalReact: false, taint: true }, true],
  ])("resolves the channel from Next.js experimental flags", (experimental, expected) => {
    expect(needsExperimentalReact(experimental)).toBe(expected);
  });

  it("resolves vendored experimental packages from the project's Next.js installation", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-experimental-react-"));
    tempDirs.push(root);
    const nextDir = path.join(root, "node_modules", "next");
    fs.mkdirSync(path.join(nextDir, "dist", "compiled"), { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), "{}");
    fs.writeFileSync(path.join(nextDir, "package.json"), '{"name":"next"}');
    for (const packageName of [
      "react-experimental",
      "react-dom-experimental",
      "react-server-dom-webpack-experimental",
    ]) {
      const packageDir = path.join(nextDir, "dist", "compiled", packageName);
      fs.mkdirSync(packageDir, { recursive: true });
      fs.writeFileSync(path.join(packageDir, "package.json"), "{}");
    }

    const canonicalNextDir = fs.realpathSync(nextDir);

    expect(resolveExperimentalReactAliases(root)).toEqual({
      react: path.join(canonicalNextDir, "dist", "compiled", "react-experimental"),
      "react-dom": path.join(canonicalNextDir, "dist", "compiled", "react-dom-experimental"),
      "react-server-dom-webpack": path.join(
        canonicalNextDir,
        "dist",
        "compiled",
        "react-server-dom-webpack-experimental",
      ),
    });
  });

  it("resolves package exports using environment-specific React conditions", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-experimental-react-"));
    tempDirs.push(root);
    const reactDir = path.join(root, "react-experimental");
    const reactDomDir = path.join(root, "react-dom-experimental");
    const reactServerDomDir = path.join(root, "react-server-dom-webpack-experimental");
    fs.mkdirSync(reactDir, { recursive: true });
    fs.mkdirSync(reactDomDir, { recursive: true });
    fs.mkdirSync(reactServerDomDir, { recursive: true });
    fs.writeFileSync(
      path.join(reactDir, "package.json"),
      JSON.stringify({
        exports: {
          ".": { "react-server": "./react-server.js", default: "./index.js" },
          "./jsx-runtime": {
            "react-server": "./jsx-runtime.react-server.js",
            default: "./jsx-runtime.js",
          },
        },
      }),
    );
    fs.writeFileSync(
      path.join(reactDomDir, "package.json"),
      JSON.stringify({
        exports: { ".": { "react-server": "./server.js", default: "./index.js" } },
      }),
    );
    fs.writeFileSync(
      path.join(reactServerDomDir, "package.json"),
      JSON.stringify({ exports: { "./server.edge": "./server.edge.js" } }),
    );
    const packages = {
      react: reactDir,
      "react-dom": reactDomDir,
      "react-server-dom-webpack": reactServerDomDir,
    };

    expect(resolveExperimentalReactSpecifier(packages, "react", "rsc")).toBe(
      path.join(reactDir, "react-server.js"),
    );
    expect(resolveExperimentalReactSpecifier(packages, "react", "ssr")).toBe(
      path.join(reactDir, "index.js"),
    );
    expect(resolveExperimentalReactSpecifier(packages, "react/jsx-runtime", "client")).toBe(
      path.join(reactDir, "jsx-runtime.js"),
    );
    const clientAliases = createExperimentalReactEnvironmentAliases(packages, "client");
    expect(clientAliases.find(({ find }) => find.test("react"))?.replacement).toBe(
      path.join(reactDir, "index.js"),
    );
    expect(
      createExperimentalReactEnvironmentAliases(packages, "rsc").find(({ find }) =>
        find.test("react-server-dom-webpack/server.edge"),
      )?.replacement,
    ).toBe(path.join(reactServerDomDir, "server.edge.js"));
  });
});
