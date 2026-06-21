import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-styled-jsx-types-"));

beforeAll(() => {
  execFileSync("vp", ["run", "vinext#build"], {
    cwd: repoRoot,
    stdio: "pipe",
  });

  const packageDir = path.join(tempDir, "node_modules/vinext");
  fs.mkdirSync(packageDir, { recursive: true });
  fs.cpSync(path.join(repoRoot, "packages/vinext/dist"), path.join(packageDir, "dist"), {
    recursive: true,
  });
  fs.copyFileSync(
    path.join(repoRoot, "packages/vinext/package.json"),
    path.join(packageDir, "package.json"),
  );
  fs.symlinkSync(
    path.join(repoRoot, "packages/vinext/node_modules"),
    path.join(packageDir, "node_modules"),
    "dir",
  );
  fs.mkdirSync(path.join(tempDir, "node_modules/@types"), { recursive: true });
  fs.symlinkSync(
    path.join(repoRoot, "node_modules/@types/react"),
    path.join(tempDir, "node_modules/@types/react"),
    "dir",
  );
}, 60_000);

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("styled-jsx public types", () => {
  it("ships the documented public type surface through the built package", () => {
    const consumerPath = path.join(tempDir, "consumer.tsx");
    fs.writeFileSync(
      consumerPath,
      `import "vinext";
import { createStyleRegistry, useStyleRegistry } from "styled-jsx";
import type { StyledJsxStyleRegistry } from "styled-jsx";
import JSXStyle from "styled-jsx/style";
import css from "styled-jsx/css";
import type { JSX } from "react";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false;
type Assert<Value extends true> = Value;
type CssExport = Assert<Equal<typeof import("styled-jsx/css"), typeof css>>;

const registry: StyledJsxStyleRegistry = createStyleRegistry();
registry.add({ id: "consumer-style", children: "p { color: red }" });
registry.remove({ id: "consumer-style", children: "p { color: red }" });

const hookRegistry: StyledJsxStyleRegistry = useStyleRegistry();
hookRegistry.add(null);
hookRegistry.remove(null);

const styles = css\`p { color: red }\`;
const globalStyles = css.global\`body { margin: 0 }\`;
const resolved = css.resolve\`p { color: red }\`;
type CssReturn = Assert<Equal<typeof styles, JSX.Element>>;
type GlobalReturn = Assert<Equal<typeof globalStyles, JSX.Element>>;
type ResolveReturn = Assert<
  Equal<typeof resolved, { className: string; styles: JSX.Element }>
>;

export type StyledJsxCssAssertions = CssExport | CssReturn | GlobalReturn | ResolveReturn;

export function Consumer() {
  return (
    <>
      <style jsx global>{\`p { color: red }\`}</style>
      <JSXStyle id="consumer-style">{resolved.styles}</JSXStyle>
      <p className={resolved.className}>styled-jsx consumer</p>
    </>
  );
}
`,
    );

    const program = ts.createProgram([consumerPath], {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      jsx: ts.JsxEmit.Preserve,
      strict: true,
      noEmit: true,
      skipLibCheck: true,
    });
    const diagnostics = ts
      .getPreEmitDiagnostics(program)
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));

    expect(diagnostics).toEqual([]);
  });
});
