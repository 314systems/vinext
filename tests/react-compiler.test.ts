/**
 * Tests for the React Compiler wiring helpers
 * (packages/vinext/src/config/react-compiler.ts).
 *
 * Mirrors Next.js behavior in packages/next/src/build/get-babel-loader-config.ts:
 * - the compiler plugin runs on client bundles only (skipped for SSR)
 * - `target: '18'` is pinned when the installed React major version is 18
 * - anonymous functions are named in dev
 * - the compiler plugin runs first in the Babel pipeline
 */
import { describe, it, expect } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildReactCompilerBabelPlugin,
  composeReactCompilerBabel,
  createReactCompilerRolldownBabelPreset,
  detectReactMajorVersion,
  getReactCompilerRuntime,
  type ReactCompilerBabelPluginEntry,
} from "../packages/vinext/src/config/react-compiler.js";

const PLUGIN_PATH = "/project/node_modules/babel-plugin-react-compiler/dist/index.js";

describe("buildReactCompilerBabelPlugin", () => {
  it("builds a plugin entry with the resolved plugin path", () => {
    const [pluginPath, options] = buildReactCompilerBabelPlugin(
      {},
      { pluginPath: PLUGIN_PATH, dev: false },
    );
    expect(pluginPath).toBe(PLUGIN_PATH);
    expect(options).toEqual({ environment: { enableNameAnonymousFunctions: false } });
  });

  it("forwards normalized compiler options", () => {
    const [, options] = buildReactCompilerBabelPlugin(
      { compilationMode: "annotation", panicThreshold: "all_errors" },
      { pluginPath: PLUGIN_PATH, dev: false },
    );
    expect(options).toEqual({
      compilationMode: "annotation",
      panicThreshold: "all_errors",
      environment: { enableNameAnonymousFunctions: false },
    });
  });

  it("names anonymous functions in dev", () => {
    const [, options] = buildReactCompilerBabelPlugin({}, { pluginPath: PLUGIN_PATH, dev: true });
    expect(options.environment).toEqual({ enableNameAnonymousFunctions: true });
  });

  it("pins target '18' when the installed React major version is 18", () => {
    const [, options] = buildReactCompilerBabelPlugin(
      {},
      { pluginPath: PLUGIN_PATH, dev: false, reactMajorVersion: "18" },
    );
    expect(options.target).toBe("18");
  });

  it("omits target for React 19 (the compiler default)", () => {
    const [, options] = buildReactCompilerBabelPlugin(
      {},
      { pluginPath: PLUGIN_PATH, dev: false, reactMajorVersion: "19" },
    );
    expect(options).not.toHaveProperty("target");
  });
});

describe("detectReactMajorVersion", () => {
  it("reads the major version of react resolved from the project root", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-react-compiler-"));
    try {
      fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "t" }));
      const reactDir = path.join(tmpDir, "node_modules", "react");
      fs.mkdirSync(reactDir, { recursive: true });
      fs.writeFileSync(
        path.join(reactDir, "package.json"),
        JSON.stringify({ name: "react", version: "18.3.1", main: "index.js" }),
      );
      fs.writeFileSync(path.join(reactDir, "index.js"), "module.exports = {};\n");

      expect(detectReactMajorVersion(tmpDir)).toBe("18");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns undefined when react is not resolvable", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-react-compiler-"));
    try {
      fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "t" }));
      expect(detectReactMajorVersion(tmpDir)).toBeUndefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("composeReactCompilerBabel", () => {
  const entry: ReactCompilerBabelPluginEntry = [
    PLUGIN_PATH,
    { environment: { enableNameAnonymousFunctions: false } },
  ];

  it("prepends the compiler plugin for client transforms", () => {
    const babel = composeReactCompilerBabel(undefined, () => entry);
    expect(babel("/app/page.tsx", {})).toEqual({ plugins: [entry] });
  });

  it("skips the compiler plugin for SSR transforms (client-only, matching Next.js)", () => {
    const babel = composeReactCompilerBabel(undefined, () => entry);
    expect(babel("/app/page.tsx", { ssr: true })).toEqual({});
  });

  it("returns the user's babel options untouched when the compiler is disabled", () => {
    const babel = composeReactCompilerBabel({ plugins: ["user-plugin"] }, () => null);
    expect(babel("/app/page.tsx", {})).toEqual({ plugins: ["user-plugin"] });
  });

  it("runs the compiler plugin first, before user-supplied plugins", () => {
    const babel = composeReactCompilerBabel({ plugins: ["user-plugin"] }, () => entry);
    expect(babel("/app/page.tsx", {})).toEqual({ plugins: [entry, "user-plugin"] });
  });

  it("composes with a function-form user babel option", () => {
    const babel = composeReactCompilerBabel(
      (id, options) => ({ plugins: [`user-${id}-${options.ssr ? "ssr" : "client"}`] }),
      () => entry,
    );
    expect(babel("/a.tsx", {})).toEqual({ plugins: [entry, "user-/a.tsx-client"] });
    expect(babel("/a.tsx", { ssr: true })).toEqual({ plugins: ["user-/a.tsx-ssr"] });
  });

  it("preserves other user babel options while injecting plugins", () => {
    const babel = composeReactCompilerBabel({ babelrc: false }, () => entry);
    expect(babel("/a.tsx", {})).toEqual({ babelrc: false, plugins: [entry] });
  });
});

describe("createReactCompilerRolldownBabelPreset", () => {
  const entry: ReactCompilerBabelPluginEntry = [
    PLUGIN_PATH,
    { environment: { enableNameAnonymousFunctions: false } },
  ];

  it("stays inactive until next.config enables the compiler", () => {
    let currentEntry: ReactCompilerBabelPluginEntry | null = null;
    const preset = createReactCompilerRolldownBabelPreset(() => currentEntry);

    expect(preset.preset()).toEqual({ plugins: [] });
    expect(preset.rolldown.applyToEnvironmentHook({ config: { consumer: "client" } })).toBe(false);

    currentEntry = entry;
    expect(preset.preset()).toEqual({ plugins: [entry] });
    expect(preset.rolldown.applyToEnvironmentHook({ config: { consumer: "client" } })).toBe(true);
  });

  it("only applies to client environments", () => {
    const preset = createReactCompilerRolldownBabelPreset(() => entry);
    expect(preset.rolldown.applyToEnvironmentHook({ config: { consumer: "server" } })).toBe(false);
  });

  it("pre-optimizes the compiler runtime matching the React target", () => {
    const react18Entry: ReactCompilerBabelPluginEntry = [PLUGIN_PATH, { target: "18" }];
    const react18Preset = createReactCompilerRolldownBabelPreset(() => react18Entry);
    expect(react18Preset.rolldown.optimizeDeps.include).toEqual(["react-compiler-runtime"]);

    const react19Preset = createReactCompilerRolldownBabelPreset(() => entry);
    expect(react19Preset.rolldown.optimizeDeps.include).toEqual(["react/compiler-runtime"]);
    expect(getReactCompilerRuntime(react18Entry)).toBe("react-compiler-runtime");
    expect(getReactCompilerRuntime(entry)).toBe("react/compiler-runtime");
  });

  it("uses the annotation filter for annotation mode", () => {
    const annotationEntry: ReactCompilerBabelPluginEntry = [
      PLUGIN_PATH,
      { compilationMode: "annotation" },
    ];
    const preset = createReactCompilerRolldownBabelPreset(() => annotationEntry);
    expect(preset.rolldown.filter.code.test('"use memo";')).toBe(true);
    expect(preset.rolldown.filter.code.test("function Component() {}")).toBe(false);
  });
});
