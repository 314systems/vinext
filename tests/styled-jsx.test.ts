import { describe, expect, it } from "vitest";
import { createStyledJsxPlugin } from "../packages/vinext/src/plugins/styled-jsx.js";

function getTransform() {
  const transform = createStyledJsxPlugin().transform;
  if (!transform || typeof transform === "function") throw new Error("Expected transform handler");
  return transform.handler;
}

describe("styled-jsx transform", () => {
  it("compiles and scopes Pages Router style jsx blocks", async () => {
    // Ported from Next.js: test/e2e/streaming-ssr/streaming-ssr/pages/index.js
    // https://github.com/vercel/next.js/blob/canary/test/e2e/streaming-ssr/streaming-ssr/pages/index.js
    const source = `
      export default function Page() {
        return <div><style jsx>{\`p { color: blue; }\`}</style><p>index</p></div>
      }
    `;

    const result = await getTransform().call({} as never, source, "/app/pages/index.js", {
      moduleType: "js",
    });

    expect(result).toBeTruthy();
    expect(typeof result === "object" && result ? result.code : "").toMatch(/color:blue/);
    expect(typeof result === "object" && result ? result.code : "").toContain("styled-jsx/style");
    expect(typeof result === "object" && result ? result.code : "").toMatch(/className=.*jsx-/);
  });

  it("skips files without style jsx blocks", async () => {
    const result = await getTransform().call(
      {} as never,
      "export default function Page() { return <p>plain</p> }",
      "/app/pages/index.tsx",
      { moduleType: "js" },
    );

    expect(result).toBeUndefined();
  });

  it("compiles external styled-jsx/css resolve modules and returns a source map", async () => {
    // Ported from Next.js: test/e2e/app-dir/use-server-inserted-html/app/css-in-js/styled-jsx.js
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/use-server-inserted-html/app/css-in-js/styled-jsx.js
    const source = `
      import css from "styled-jsx/css";
      export const elementStyles = css\`
        .external-element { background: yellow; }
      \`;
      export const externalStyles = css.resolve\`
        .external { color: hotpink; }
      \`;
    `;

    const result = await getTransform().call({} as never, source, "/app/styles.tsx", {
      moduleType: "js",
    });

    expect(result).toBeTruthy();
    expect(typeof result === "object" && result ? result.code : "").toMatch(
      /color:(?:hotpink|#ff69b4)/,
    );
    expect(typeof result === "object" && result ? result.code : "").toMatch(
      /background:(?:yellow|#ff0)/,
    );
    expect(typeof result === "object" && result ? result.code : "").toContain("className");
    expect(typeof result === "object" && result ? result.map : null).toBeTruthy();
  });
});
