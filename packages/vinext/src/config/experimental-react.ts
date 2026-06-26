import path from "node:path";
import { createRequire } from "node:module";
import fs from "node:fs";

export type ExperimentalReactAliases = Record<string, string>;
export type ExperimentalReactEnvironment = "rsc" | "ssr" | "client";
export type ExperimentalReactAliasEntry = { find: RegExp; replacement: string };
type EsbuildPlugin = {
  name: string;
  setup(build: {
    onResolve(
      options: { filter: RegExp },
      callback: (args: { path: string }) => { path: string } | undefined,
    ): void;
  }): void;
};

type PackageExport = string | PackageExportConditions;
type PackageExportConditions = {
  [condition: string]: PackageExport;
};

export function needsExperimentalReact(experimental: Record<string, unknown> | undefined): boolean {
  return (
    experimental?.taint === true ||
    experimental?.transitionIndicator === true ||
    experimental?.gestureTransition === true
  );
}

export function resolveExperimentalReactAliases(root: string): ExperimentalReactAliases {
  const requireRoots = [root, process.cwd()];
  let nextPackagePath: string | undefined;
  let cause: unknown;
  for (const requireRoot of requireRoots) {
    try {
      nextPackagePath = createRequire(path.join(requireRoot, "package.json")).resolve(
        "next/package.json",
      );
      break;
    } catch (error) {
      cause = error;
    }
  }
  if (!nextPackagePath) {
    throw new Error(
      "[vinext] React's experimental channel requires the project's installed `next` package.",
      { cause },
    );
  }

  const compiledDir = path.join(path.dirname(nextPackagePath), "dist", "compiled");
  const packages = {
    react: path.join(compiledDir, "react-experimental"),
    "react-dom": path.join(compiledDir, "react-dom-experimental"),
    "react-server-dom-webpack": path.join(compiledDir, "react-server-dom-webpack-experimental"),
  };

  for (const [specifier, packageDir] of Object.entries(packages)) {
    if (!fs.existsSync(path.join(packageDir, "package.json"))) {
      throw new Error(
        `[vinext] The installed Next.js package does not include the experimental ${specifier} runtime.`,
      );
    }
  }

  return packages;
}

export function resolveExperimentalReactSpecifier(
  packages: ExperimentalReactAliases,
  specifier: string,
  environment: "rsc" | "ssr" | "client",
): string | null {
  const packageName = Object.keys(packages).find(
    (candidate) => specifier === candidate || specifier.startsWith(`${candidate}/`),
  );
  if (!packageName) return null;

  const packageDir = packages[packageName];
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(packageDir, "package.json"), "utf8"),
  ) as { exports?: Record<string, PackageExport> };
  const exportKey = specifier === packageName ? "." : `.${specifier.slice(packageName.length)}`;
  const packageExport = packageJson.exports?.[exportKey];
  if (!packageExport) return null;

  const conditions =
    environment === "rsc"
      ? ["react-server", "workerd", "edge-light", "node", "browser", "default"]
      : environment === "client"
        ? ["browser", "worker", "default"]
        : ["workerd", "edge-light", "node", "default"];
  const target = selectPackageExport(packageExport, conditions);
  return target ? path.join(packageDir, target) : null;
}

export const EXPERIMENTAL_REACT_SPECIFIERS = [
  "react",
  "react/compiler-runtime",
  "react/jsx-dev-runtime",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  "react-dom/server",
  "react-dom/server.browser",
  "react-dom/server.edge",
  "react-dom/server.node",
  "react-dom/static",
  "react-dom/static.browser",
  "react-dom/static.edge",
  "react-dom/static.node",
  "react-server-dom-webpack/client",
  "react-server-dom-webpack/client.browser",
  "react-server-dom-webpack/client.edge",
  "react-server-dom-webpack/client.node",
  "react-server-dom-webpack/server",
  "react-server-dom-webpack/server.browser",
  "react-server-dom-webpack/server.edge",
  "react-server-dom-webpack/server.node",
  "react-server-dom-webpack/static",
  "react-server-dom-webpack/static.browser",
  "react-server-dom-webpack/static.edge",
  "react-server-dom-webpack/static.node",
] as const;

export function isExperimentalReactSpecifier(specifier: string): boolean {
  return EXPERIMENTAL_REACT_SPECIFIERS.some(
    (candidate) => specifier === candidate || specifier.startsWith(`${candidate}/`),
  );
}

export function createExperimentalReactEnvironmentAliases(
  packages: ExperimentalReactAliases,
  environment: ExperimentalReactEnvironment,
): ExperimentalReactAliasEntry[] {
  const packageAliases = EXPERIMENTAL_REACT_SPECIFIERS.flatMap((specifier) => {
    const replacement = resolveExperimentalReactSpecifier(packages, specifier, environment);
    return replacement
      ? [{ find: new RegExp(`^${specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), replacement }]
      : [];
  });

  return [
    ...packageAliases,
    {
      find: /^next\/dist\/compiled\/react-experimental$/,
      replacement: requireExperimentalReactSpecifier(packages, "react", environment),
    },
    {
      find: /^next\/dist\/compiled\/react-dom-experimental$/,
      replacement: requireExperimentalReactSpecifier(packages, "react-dom", environment),
    },
    {
      find: /^next\/dist\/compiled\/react-server-dom-webpack-experimental$/,
      replacement: requireExperimentalReactSpecifier(
        packages,
        "react-server-dom-webpack",
        environment,
      ),
    },
  ];
}

export function createExperimentalReactEsbuildPlugin(
  aliases: ExperimentalReactAliasEntry[],
  environment: ExperimentalReactEnvironment,
): EsbuildPlugin {
  return {
    name: `vinext:experimental-react-dep-optimize:${environment}`,
    setup(build) {
      build.onResolve({ filter: /^(?:react|next\/dist\/compiled\/react)/ }, (args) => {
        const replacement = aliases.find(({ find }) => find.test(args.path))?.replacement;
        return replacement ? { path: replacement } : undefined;
      });
    },
  };
}

function requireExperimentalReactSpecifier(
  packages: ExperimentalReactAliases,
  specifier: string,
  environment: ExperimentalReactEnvironment,
): string {
  const resolved = resolveExperimentalReactSpecifier(packages, specifier, environment);
  if (!resolved) {
    throw new Error(
      `[vinext] Next.js's experimental React runtime does not export ${specifier} for the ${environment} environment.`,
    );
  }
  return resolved;
}

function selectPackageExport(
  packageExport: PackageExport,
  conditions: readonly string[],
): string | null {
  if (typeof packageExport === "string") return packageExport;
  for (const condition of conditions) {
    const target = packageExport[condition];
    if (target) return selectPackageExport(target, conditions);
  }
  return null;
}
