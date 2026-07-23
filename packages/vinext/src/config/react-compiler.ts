/**
 * React Compiler wiring for @vitejs/plugin-react.
 *
 * Next.js runs the React Compiler as a Babel plugin on client bundles only
 * (see packages/next/src/build/get-babel-loader-config.ts — the plugin list is
 * skipped when `isServer`). vinext mirrors that by injecting
 * `babel-plugin-react-compiler` into @vitejs/plugin-react's Babel pipeline via
 * a function-form `babel` option, which is evaluated per-file at transform
 * time — after next.config has been resolved in the `config` hook.
 */
import { createRequire } from "node:module";
import path from "pathslash";
import type { ReactCompilerOptions } from "./next-config.js";

/** A `[pluginPath, options]` Babel plugin entry for `babel.plugins`. */
export type ReactCompilerBabelPluginEntry = [string, Record<string, unknown>];

export type ReactCompilerRolldownBabelPreset = {
  preset: () => { plugins: ReactCompilerBabelPluginEntry[] };
  rolldown: {
    filter: { code: RegExp };
    applyToEnvironmentHook: (environment: { config: { consumer?: string } }) => boolean;
    optimizeDeps: { include: string[] };
  };
};

export function getReactCompilerRuntime(
  pluginEntry: ReactCompilerBabelPluginEntry,
): "react-compiler-runtime" | "react/compiler-runtime" {
  return pluginEntry[1].target === "18" ? "react-compiler-runtime" : "react/compiler-runtime";
}

/**
 * Build the Babel plugin entry for the React Compiler.
 *
 * Mirrors Next.js's `getReactCompilerPlugins`
 * (packages/next/src/build/get-babel-loader-config.ts):
 * - forwards the user's normalized compiler options
 * - pins `target: '18'` when the installed React major version is 18
 *   (React 19 is the compiler default and needs no explicit target)
 * - names anonymous functions in dev for better debugging
 */
export function buildReactCompilerBabelPlugin(
  options: ReactCompilerOptions,
  context: { pluginPath: string; dev: boolean; reactMajorVersion?: string | undefined },
): ReactCompilerBabelPluginEntry {
  const target = context.reactMajorVersion === "18" ? "18" : undefined;
  return [
    context.pluginPath,
    {
      ...options,
      ...(target ? { target } : {}),
      environment: { enableNameAnonymousFunctions: context.dev },
    },
  ];
}

/**
 * Detect the major version of the `react` package installed in the project.
 * Returns undefined when react/package.json cannot be resolved.
 */
export function detectReactMajorVersion(projectRoot: string): string | undefined {
  try {
    const projectRequire = createRequire(path.join(projectRoot, "package.json"));
    const reactPkgPath = projectRequire.resolve("react/package.json");
    const version = (projectRequire(reactPkgPath) as { version?: unknown }).version;
    if (typeof version === "string") return version.split(".")[0];
  } catch {
    // react/package.json not resolvable — skip target detection.
  }
  return undefined;
}

type BabelOptionsLike = Record<string, unknown> & { plugins?: unknown[] };
type BabelOptionInput =
  | BabelOptionsLike
  | ((id: string, options: { ssr?: boolean }) => BabelOptionsLike)
  | undefined;

/**
 * Compose @vitejs/plugin-react's `babel` option so the React Compiler plugin
 * is prepended when enabled. The compiler must run first in the Babel pipeline
 * (per the React Compiler docs) so it sees input as close to the original
 * source as possible; user-supplied plugins keep their relative order after it.
 *
 * `getPluginEntry` is read lazily per file because next.config is resolved in
 * the `config` hook, after @vitejs/plugin-react has been instantiated. Server
 * transforms (`ssr: true`) never receive the compiler plugin, matching
 * Next.js's client-only behavior.
 */
export function composeReactCompilerBabel(
  userBabel: BabelOptionInput,
  getPluginEntry: () => ReactCompilerBabelPluginEntry | null,
): (id: string, options: { ssr?: boolean }) => BabelOptionsLike {
  return (id, options) => {
    const base: BabelOptionsLike =
      typeof userBabel === "function" ? userBabel(id, options) : { ...userBabel };
    if (options.ssr) return base;
    const entry = getPluginEntry();
    if (!entry) return base;
    return {
      ...base,
      plugins: [entry, ...(Array.isArray(base.plugins) ? base.plugins : [])],
    };
  };
}

/**
 * Build the lazy preset consumed by @rolldown/plugin-babel in
 * @vitejs/plugin-react v6. The preset is created before Vite resolves config,
 * so every hook reads the entry populated from next.config later.
 */
export function createReactCompilerRolldownBabelPreset(
  getPluginEntry: () => ReactCompilerBabelPluginEntry | null,
): ReactCompilerRolldownBabelPreset {
  return {
    preset: () => {
      const entry = getPluginEntry();
      return { plugins: entry ? [entry] : [] };
    },
    rolldown: {
      get filter() {
        return {
          code:
            getPluginEntry()?.[1].compilationMode === "annotation"
              ? /['"]use memo['"]/
              : /\b[A-Z]|\buse/,
        };
      },
      applyToEnvironmentHook(environment) {
        return getPluginEntry() !== null && environment.config.consumer === "client";
      },
      get optimizeDeps() {
        const entry = getPluginEntry();
        return { include: entry ? [getReactCompilerRuntime(entry)] : [] };
      },
    },
  };
}
