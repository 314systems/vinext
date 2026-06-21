import type { Plugin } from "vite";

const STYLE_JSX_RE = /<style\s+[^>]*\bjsx(?:\s|=|>)/;
const STYLE_JSX_CSS_RE = /["']styled-jsx\/css["']/;

type BabelCore = {
  transformAsync(
    code: string,
    options: Record<string, unknown>,
  ): Promise<{
    code?: string | null;
    map?: {
      version: number;
      sources: string[];
      names: string[];
      mappings: string;
      file?: string;
      sourceRoot?: string;
      sourcesContent?: Array<string | null>;
    } | null;
  } | null>;
};

let compilerPromise: Promise<{
  babel: BabelCore;
  styledJsxPlugin: unknown;
}> | null = null;

async function loadCompiler() {
  if (!compilerPromise) {
    compilerPromise = Promise.all([import("@babel/core"), import("styled-jsx/babel")]).then(
      ([babel, styledJsx]) => ({
        babel: babel as BabelCore,
        styledJsxPlugin: styledJsx.default,
      }),
    );
  }
  return compilerPromise;
}

export function createStyledJsxPlugin(): Plugin {
  return {
    name: "vinext:styled-jsx",
    enforce: "pre",
    transform: {
      filter: { id: /\.(?:[cm]?[jt]sx?)(?:\?.*)?$/ },
      async handler(code, id) {
        if (id.includes("/node_modules/") || id.includes("?")) return;
        if (!STYLE_JSX_RE.test(code) && !STYLE_JSX_CSS_RE.test(code)) return;

        const { babel, styledJsxPlugin } = await loadCompiler();
        const result = await babel.transformAsync(code, {
          filename: id,
          babelrc: false,
          configFile: false,
          sourceMaps: true,
          parserOpts: {
            plugins: id.endsWith("x") ? ["jsx", "typescript"] : ["jsx"],
          },
          plugins: [[styledJsxPlugin, { styleModule: "styled-jsx/style" }]],
        });

        if (!result?.code) return;
        return { code: result.code, map: result.map ?? null };
      },
    },
  };
}
