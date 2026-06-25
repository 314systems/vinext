import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import type { Plugin } from "vite";

export type WebpackLoaderRule = Record<string, unknown>;
export type WebpackLoaderRules = {
  client: WebpackLoaderRule[];
  server: WebpackLoaderRule[];
};

const WEBPACK_LOADER_PREFIX = "\0vinext-webpack-loader:";

type LoaderContext = {
  async(): (error: Error | null, result?: string | Buffer) => void;
  callback(error: Error | null, result?: string | Buffer): void;
  cacheable(): void;
  context: string;
  emitError(error: Error): void;
  emitWarning(warning: Error): void;
  getOptions(): unknown;
  mode: "development" | "production";
  query: unknown;
  resource: string;
  resourcePath: string;
  rootContext: string;
};

type LoaderFunction = ((this: LoaderContext, source: string | Buffer) => unknown) & {
  raw?: boolean;
};

type ResolvedLoader = { loader: LoaderFunction; options: unknown };

const SKIP_FRAMEWORK_LOADER = Symbol("skip-framework-loader");

function matchesCondition(condition: unknown, value: string): boolean {
  if (condition === undefined) return true;
  if (condition instanceof RegExp) {
    condition.lastIndex = 0;
    return condition.test(value);
  }
  if (typeof condition === "string") return value.startsWith(condition);
  if (typeof condition === "function") return Boolean(condition(value));
  if (Array.isArray(condition)) return condition.some((entry) => matchesCondition(entry, value));
  if (condition && typeof condition === "object") {
    const record = condition as Record<string, unknown>;
    if (record.and && !Array.isArray(record.and)) return false;
    if (Array.isArray(record.and) && !record.and.every((entry) => matchesCondition(entry, value))) {
      return false;
    }
    if (Array.isArray(record.or) && !record.or.some((entry) => matchesCondition(entry, value))) {
      return false;
    }
    if (record.not !== undefined && matchesCondition(record.not, value)) return false;
    return record.and !== undefined || record.or !== undefined || record.not !== undefined;
  }
  return false;
}

function matchesRule(rule: WebpackLoaderRule, resourcePath: string): boolean {
  return (
    matchesCondition(rule.test, resourcePath) &&
    matchesCondition(rule.include, resourcePath) &&
    (rule.exclude === undefined || !matchesCondition(rule.exclude, resourcePath))
  );
}

export function collectMatchingWebpackLoaderRules(
  rules: WebpackLoaderRule[],
  resourcePath: string,
): WebpackLoaderRule[] {
  const matches: WebpackLoaderRule[] = [];
  const visit = (rule: unknown, parentMatches: boolean = true): void => {
    if (!rule || typeof rule !== "object") return;
    if (Array.isArray(rule)) {
      for (const child of rule) visit(child, parentMatches);
      return;
    }
    const record = rule as WebpackLoaderRule;
    const ruleMatches = parentMatches && matchesRule(record, resourcePath);
    if (!ruleMatches) return;
    if (Array.isArray(record.oneOf)) {
      const match = record.oneOf.find(
        (child) =>
          child !== null &&
          typeof child === "object" &&
          matchesRule(child as WebpackLoaderRule, resourcePath),
      );
      if (match) visit(match, ruleMatches);
    }
    if (Array.isArray(record.rules)) {
      for (const child of record.rules) visit(child, ruleMatches);
    }
    matches.push(record);
  };
  for (const rule of rules) visit(rule);
  return matches;
}

function loaderEntries(rule: WebpackLoaderRule): unknown[] {
  const uses = Array.isArray(rule.use) ? rule.use : rule.use ? [rule.use] : [];
  return rule.loader === undefined
    ? uses
    : [...uses, { loader: rule.loader, options: rule.options }];
}

function isFrameworkLoader(loaderPath: string): boolean {
  return (
    loaderPath.includes("next-babel-loader") ||
    loaderPath.includes("mdx") ||
    loaderPath.startsWith("next/dist/build/webpack")
  );
}

function resolveLoader(
  entry: unknown,
  requireFromRoot: NodeJS.Require,
): ResolvedLoader | typeof SKIP_FRAMEWORK_LOADER | null {
  let loader: unknown;
  let options: unknown;
  if (typeof entry === "function") loader = entry;
  else if (typeof entry === "string") {
    if (isFrameworkLoader(entry)) return SKIP_FRAMEWORK_LOADER;
    try {
      loader = requireFromRoot(entry);
    } catch {
      return null;
    }
  } else if (entry && typeof entry === "object") {
    const record = entry as Record<string, unknown>;
    options = record.options;
    if (typeof record.loader === "function") loader = record.loader;
    else if (typeof record.loader === "string") {
      if (isFrameworkLoader(record.loader)) return SKIP_FRAMEWORK_LOADER;
      try {
        loader = requireFromRoot(record.loader);
      } catch {
        return null;
      }
    }
  }
  if (loader && typeof loader === "object" && "default" in loader) {
    loader = (loader as { default: unknown }).default;
  }
  return typeof loader === "function" ? { loader: loader as LoaderFunction, options } : null;
}

async function runLoader(
  loader: LoaderFunction,
  source: string | Buffer,
  options: unknown,
  resourcePath: string,
  root: string,
  mode: "development" | "production",
): Promise<string | Buffer> {
  return new Promise((resolve, reject) => {
    let completed = false;
    let asyncRequested = false;
    const complete = (error: Error | null, result?: string | Buffer): void => {
      if (completed) return;
      completed = true;
      if (error) reject(error);
      else resolve(result ?? source);
    };
    const context: LoaderContext = {
      async: () => {
        asyncRequested = true;
        return complete;
      },
      callback: complete,
      cacheable: () => {},
      context: path.dirname(resourcePath),
      emitError: reject,
      emitWarning: (warning) => console.warn(warning),
      getOptions: () => options ?? {},
      mode,
      query: options ?? {},
      resource: resourcePath,
      resourcePath,
      rootContext: root,
    };
    try {
      const input =
        loader.raw === true
          ? typeof source === "string"
            ? Buffer.from(source)
            : source
          : Buffer.isBuffer(source)
            ? source.toString("utf8")
            : source;
      const result = loader.call(context, input);
      if (result && typeof (result as Promise<unknown>).then === "function") {
        void (result as Promise<unknown>).then(
          (value) => complete(null, value as string | Buffer | undefined),
          reject,
        );
      } else if (result !== undefined) {
        complete(null, result as string | Buffer);
      } else if (!asyncRequested && !completed) {
        complete(null, source);
      }
    } catch (error) {
      reject(error);
    }
  });
}

export function createWebpackLoaderCompatPlugin(
  getRules: () => WebpackLoaderRules,
  getRoot: () => string,
): Plugin {
  const rulesForEnvironment = (environmentName: string | undefined): WebpackLoaderRule[] =>
    environmentName === "client" ? getRules().client : getRules().server;

  const resolveMatchingLoaders = (
    rules: WebpackLoaderRule[],
    root: string,
  ): ResolvedLoader[] | null => {
    const requireFromRoot = createRequire(path.join(root, "package.json"));
    const loaders = rules
      .flatMap(loaderEntries)
      .map((entry) => resolveLoader(entry, requireFromRoot));
    if (loaders.some((entry) => entry === null)) return null;
    const compatibleLoaders = loaders.filter(
      (entry): entry is ResolvedLoader => entry !== SKIP_FRAMEWORK_LOADER,
    );
    return compatibleLoaders.length > 0 ? compatibleLoaders : null;
  };

  return {
    name: "vinext:webpack-loader-compat",
    enforce: "pre",
    async resolveId(source, importer) {
      const configuredRules = rulesForEnvironment(this.environment?.name);
      if (configuredRules.length === 0) return null;
      if (source.startsWith(WEBPACK_LOADER_PREFIX) || source.startsWith("\0")) return null;
      const resolved = await this.resolve(source, importer, { skipSelf: true });
      if (!resolved || resolved.external) return null;
      const resourcePath = resolved.id.split("?", 1)[0];
      if (resourcePath.startsWith("\0")) return null;
      const matchingRules = collectMatchingWebpackLoaderRules(configuredRules, resourcePath);
      if (!resolveMatchingLoaders(matchingRules, getRoot())) return null;
      return `${WEBPACK_LOADER_PREFIX}${resourcePath}`;
    },
    async load(id) {
      if (!id.startsWith(WEBPACK_LOADER_PREFIX)) return null;
      const resourcePath = id.slice(WEBPACK_LOADER_PREFIX.length);
      const rules = collectMatchingWebpackLoaderRules(
        rulesForEnvironment(this.environment?.name),
        resourcePath,
      );
      if (rules.length === 0) return null;

      const root = getRoot();
      const loaders = resolveMatchingLoaders(rules, root);
      if (!loaders) return null;

      let source: string | Buffer = await fs.readFile(resourcePath);
      for (const entry of loaders.reverse()) {
        source = await runLoader(
          entry.loader,
          source,
          entry.options,
          resourcePath,
          root,
          this.environment?.mode === "dev" ? "development" : "production",
        );
      }
      return typeof source === "string" ? source : source.toString("utf8");
    },
  };
}
