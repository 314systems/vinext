import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createStyledJsxPlugin } from "../packages/vinext/src/plugins/styled-jsx.js";

function getTransform(transpilePackages: readonly string[] = []) {
  const transform = createStyledJsxPlugin({
    getTranspilePackages: () => transpilePackages,
  }).transform;
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
      const accent: string = "hotpink";
      export const elementStyles = css\`
        .external-element { background: yellow; }
      \`;
      export const externalStyles = css.resolve\`
        .external { color: \${accent}; }
      \`;
    `;

    const result = await getTransform().call({} as never, source, "/app/styles.ts", {
      moduleType: "js",
    });

    expect(result).toBeTruthy();
    expect(typeof result === "object" && result ? result.code : "").toContain(
      'const accent = "hotpink"',
    );
    expect(typeof result === "object" && result ? result.code : "").toContain("color:${accent}");
    expect(typeof result === "object" && result ? result.code : "").not.toContain("<_JSXStyle");
    expect(typeof result === "object" && result ? result.code : "").toMatch(
      /background:(?:yellow|#ff0)/,
    );
    expect(typeof result === "object" && result ? result.code : "").toContain("className");
    expect(typeof result === "object" && result ? result.map : null).toBeTruthy();
  });

  it("compiles raw styled-jsx from transpilePackages dependencies", async () => {
    const fixtureRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-styled-jsx-packages-"));
    const installedPackage = path.join(fixtureRoot, "node_modules", "raw-styled-jsx");
    const workspacePackage = path.join(fixtureRoot, "packages", "raw-styled-jsx");
    const workspaceLink = path.join(fixtureRoot, "node_modules", "@workspace", "raw-styled-jsx");
    const source = `
      export function RawPackageComponent() {
        return <div><style jsx>{\`p { color: green; }\`}</style><p>package</p></div>
      }
    `;
    try {
      await fsp.mkdir(installedPackage, { recursive: true });
      await fsp.mkdir(workspacePackage, { recursive: true });
      await fsp.mkdir(path.dirname(workspaceLink), { recursive: true });
      await fsp.writeFile(path.join(installedPackage, "index.tsx"), source);
      await fsp.writeFile(path.join(workspacePackage, "index.tsx"), source);
      await fsp.symlink(workspacePackage, workspaceLink, "junction");

      const transform = getTransform(["raw-styled-jsx", "@workspace/raw-styled-jsx"]);
      const installedId = path.join(installedPackage, "index.tsx");
      const workspaceId = path.join(workspaceLink, "index.tsx");
      const installedResult = await transform.call(
        {} as never,
        await fsp.readFile(installedId, "utf8"),
        installedId,
        { moduleType: "js" },
      );
      const workspaceResult = await transform.call(
        {} as never,
        await fsp.readFile(workspaceId, "utf8"),
        workspaceId,
        { moduleType: "js" },
      );

      expect(
        typeof installedResult === "object" && installedResult ? installedResult.code : "",
      ).toContain("styled-jsx/style");
      expect(
        typeof workspaceResult === "object" && workspaceResult ? workspaceResult.code : "",
      ).toContain("styled-jsx/style");
    } finally {
      await fsp.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("skips external, precompiled, and styled-jsx dependency modules", async () => {
    const rawSource = `
      export function ExternalComponent() {
        return <div><style jsx>{\`p { color: red; }\`}</style><p>external</p></div>
      }
    `;
    const precompiledSource = `
      import _JSXStyle from "styled-jsx/style";
      export function PrecompiledComponent() {
        return <div className="jsx-123"><_JSXStyle id="123">{\`p { color: blue; }\`}</_JSXStyle></div>
      }
    `;
    const transform = getTransform(["precompiled-package", "styled-jsx"]);

    await expect(
      transform.call({} as never, rawSource, "/app/node_modules/external-package/index.tsx", {
        moduleType: "js",
      }),
    ).resolves.toBeUndefined();
    await expect(
      transform.call(
        {} as never,
        precompiledSource,
        "/app/node_modules/precompiled-package/index.js",
        { moduleType: "js" },
      ),
    ).resolves.toBeUndefined();
    await expect(
      transform.call({} as never, rawSource, "/app/node_modules/styled-jsx/index.js", {
        moduleType: "js",
      }),
    ).resolves.toBeUndefined();
  });
});
