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
});

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("styled-jsx public types", () => {
  it("ships the registry type and hooks through the built package", () => {
    const consumerPath = path.join(tempDir, "consumer.ts");
    fs.writeFileSync(
      consumerPath,
      `import "vinext";
import { createStyleRegistry, useStyleRegistry } from "styled-jsx";
import type { StyledJsxStyleRegistry } from "styled-jsx";

const registry: StyledJsxStyleRegistry = createStyleRegistry();
registry.add({ id: "consumer-style", children: "p { color: red }" });
registry.remove({ id: "consumer-style", children: "p { color: red }" });

const hookRegistry: StyledJsxStyleRegistry = useStyleRegistry();
hookRegistry.add(null);
hookRegistry.remove(null);
`,
    );

    const program = ts.createProgram([consumerPath], {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
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
