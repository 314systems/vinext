import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { Plugin } from "vite";
import { relativeWithinRoot, tryRealpathSync } from "../build/ssr-manifest.js";

const BABEL_CONFIG_FILES = [
  ".babelrc",
  ".babelrc.json",
  ".babelrc.js",
  ".babelrc.mjs",
  ".babelrc.cjs",
  "babel.config.js",
  "babel.config.json",
  "babel.config.mjs",
  "babel.config.cjs",
];

type BabelCore = {
  transformAsync(
    code: string,
    options: Record<string, unknown>,
  ): Promise<{
    code?: string | null;
    map?: {
      version: number;
      mappings: string;
      names: string[];
      sources: string[];
      sourcesContent?: Array<string | null>;
      file?: string;
      sourceRoot?: string;
    } | null;
  } | null>;
};

type BabelConfigPluginOptions = {
  forceSwcTransforms: boolean;
  transpilePackages: string[];
};

function findBabelConfig(root: string): string | null {
  for (const file of BABEL_CONFIG_FILES) {
    const configPath = path.join(root, file);
    if (fs.existsSync(configPath)) return configPath;
  }
  return null;
}

function resolveBabelCore(root: string): string | null {
  const projectRequire = createRequire(path.join(root, "package.json"));
  try {
    return projectRequire.resolve("@babel/core");
  } catch {}

  try {
    const nextRequire = createRequire(projectRequire.resolve("next/package.json"));
    return nextRequire.resolve("next/dist/compiled/babel/core");
  } catch {}

  return null;
}

function isPathInPackage(filename: string, packageName: string): boolean {
  const packagePath = packageName.replaceAll("/", path.sep);
  return filename.includes(`${path.sep}node_modules${path.sep}${packagePath}${path.sep}`);
}

function resolvePackageRoot(root: string, packageName: string): string | null {
  const projectRequire = createRequire(path.join(root, "package.json"));
  let currentDir: string;
  try {
    currentDir = path.dirname(projectRequire.resolve(packageName));
  } catch {
    return null;
  }

  while (currentDir !== path.dirname(currentDir)) {
    const packageJsonPath = path.join(currentDir, "package.json");
    try {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
        name?: unknown;
      };
      if (packageJson.name === packageName) return tryRealpathSync(currentDir) ?? currentDir;
    } catch {}
    currentDir = path.dirname(currentDir);
  }
  return null;
}

export function createBabelConfigPlugin(
  getOptions: () => BabelConfigPluginOptions = () => ({
    forceSwcTransforms: false,
    transpilePackages: [],
  }),
): Plugin {
  let root = process.cwd();
  let canonicalRoot = fs.realpathSync.native(root);
  let babelCorePromise: Promise<BabelCore> | null = null;
  let configPath: string | null = null;
  let srcDir = canonicalRoot;
  let pagesDir = path.join(canonicalRoot, "src", "pages");
  let transpilePackageRoots = new Map<string, string | null>();

  return {
    name: "vinext:babel-config",
    enforce: "pre",
    configResolved(config) {
      root = config.root;
      canonicalRoot = fs.realpathSync.native(root);
      configPath = findBabelConfig(root);
      transpilePackageRoots = new Map();
      srcDir = fs.existsSync(path.join(canonicalRoot, "src"))
        ? path.join(canonicalRoot, "src")
        : canonicalRoot;
      pagesDir = fs.existsSync(path.join(canonicalRoot, "pages"))
        ? path.join(canonicalRoot, "pages")
        : path.join(canonicalRoot, "src", "pages");
    },
    configureServer(server) {
      const configCandidates = BABEL_CONFIG_FILES.map((file) => path.join(root, file));
      server.watcher.add(configCandidates);
      let restartPending = false;
      const restartForBabelConfig = (changedPath: string) => {
        if (!configCandidates.includes(changedPath) || restartPending) return;
        restartPending = true;
        void server.restart().finally(() => {
          restartPending = false;
        });
      };
      server.watcher.on("add", restartForBabelConfig);
      server.watcher.on("change", restartForBabelConfig);
      server.watcher.on("unlink", restartForBabelConfig);
    },
    transform: {
      filter: {
        id: /\.[cm]?[jt]sx?(?:\?.*)?$/,
      },
      async handler(code, id) {
        const options = getOptions();
        if (!configPath || options.forceSwcTransforms || id.startsWith("\0")) return;

        const filename = id.replace(/\?.*$/, "");
        if (!path.isAbsolute(filename)) return;
        const canonicalFilename = tryRealpathSync(filename) ?? filename;
        const isProjectFile = relativeWithinRoot(canonicalRoot, canonicalFilename);
        const isTranspiledPackage = options.transpilePackages.some((packageName) => {
          if (isPathInPackage(filename, packageName)) return true;

          let packageRoot = transpilePackageRoots.get(packageName);
          if (packageRoot === undefined) {
            packageRoot = resolvePackageRoot(root, packageName);
            transpilePackageRoots.set(packageName, packageRoot);
          }

          return packageRoot !== null && relativeWithinRoot(packageRoot, canonicalFilename);
        });
        if (
          (!isProjectFile || filename.includes(`${path.sep}node_modules${path.sep}`)) &&
          !isTranspiledPackage
        ) {
          return;
        }

        if (!babelCorePromise) {
          const babelCorePath = resolveBabelCore(root);
          if (!babelCorePath) {
            throw new Error(
              "vinext: A Babel config was found, but @babel/core could not be resolved. " +
                "Install @babel/core in the project.",
            );
          }
          babelCorePromise = import(pathToFileURL(babelCorePath).href).then((module) => {
            const babelCore = (module.default ?? module) as BabelCore;
            if (typeof babelCore.transformAsync !== "function") {
              throw new Error("vinext: Loaded @babel/core does not export transformAsync().");
            }
            return babelCore;
          });
        }

        const babelCore = await babelCorePromise;
        const environmentConfig = this.environment?.config;
        if (!environmentConfig) return;
        const isServer = environmentConfig.consumer !== "client";
        const isDev = environmentConfig.command === "serve";
        const result = await babelCore.transformAsync(code, {
          filename: canonicalFilename,
          cwd: canonicalRoot,
          configFile: configPath,
          babelrc: false,
          sourceMaps: true,
          sourceFileName: filename,
          caller: {
            name: "next-babel-turbo-loader",
            supportsStaticESM: true,
            supportsDynamicImport: true,
            supportsTopLevelAwait: true,
            supportsExportNamespaceFrom: true,
            target: isServer ? "node" : "web",
            isServer,
            isDev,
            srcDir,
            pagesDir,
            transformMode: "default",
            hasJsxRuntime: true,
          },
        });

        if (result?.code == null) return;
        return { code: result.code, map: result.map ?? undefined };
      },
    },
  };
}
