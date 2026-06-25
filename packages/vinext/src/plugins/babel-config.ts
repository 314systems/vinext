import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { Plugin } from "vite";

const BABEL_CONFIG_FILES = [
  "babel.config.js",
  "babel.config.cjs",
  "babel.config.mjs",
  "babel.config.json",
  ".babelrc",
  ".babelrc.js",
  ".babelrc.cjs",
  ".babelrc.mjs",
  ".babelrc.json",
];

type BabelCore = {
  transformAsync(
    code: string,
    options: Record<string, unknown>,
  ): Promise<{ code?: string | null; map?: Record<string, unknown> | null } | null>;
};

function hasBabelConfig(root: string): boolean {
  return BABEL_CONFIG_FILES.some((file) => fs.existsSync(path.join(root, file)));
}

function resolveBabelCore(root: string): string | null {
  const projectRequire = createRequire(path.join(root, "package.json"));
  try {
    return projectRequire.resolve("@babel/core");
  } catch {}

  try {
    const nextRequire = createRequire(projectRequire.resolve("next/package.json"));
    return nextRequire.resolve("@babel/core");
  } catch {}

  return null;
}

export function createBabelConfigPlugin(): Plugin {
  let root = process.cwd();
  let canonicalRoot = fs.realpathSync.native(root);
  let babelCorePromise: Promise<BabelCore> | null = null;
  let enabled = false;

  return {
    name: "vinext:babel-config",
    enforce: "pre",
    configResolved(config) {
      root = config.root;
      canonicalRoot = fs.realpathSync.native(root);
      enabled = hasBabelConfig(root);
    },
    transform: {
      filter: {
        id: /\.[cm]?[jt]sx?(?:\?.*)?$/,
      },
      async handler(code, id) {
        if (!enabled || id.startsWith("\0") || id.includes("/node_modules/")) return;

        const filename = id.replace(/\?.*$/, "");
        if (!path.isAbsolute(filename)) return;
        const canonicalFilename = fs.realpathSync.native(filename);
        const relativeFilename = path.relative(canonicalRoot, canonicalFilename);
        if (relativeFilename.startsWith(`..${path.sep}`) || path.isAbsolute(relativeFilename))
          return;

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
        const result = await babelCore.transformAsync(code, {
          filename: canonicalFilename,
          cwd: canonicalRoot,
          sourceMaps: true,
          sourceFileName: filename,
          caller: {
            name: "vinext",
            supportsStaticESM: true,
            supportsDynamicImport: true,
            supportsTopLevelAwait: true,
            supportsExportNamespaceFrom: true,
          },
        });

        if (!result?.code) return;
        return { code: result.code };
      },
    },
  };
}
