import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vite-plus/test";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("styled-jsx public types", () => {
  it("supports the named registry type and add/remove methods", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-styled-jsx-types-"));
    tempDirs.push(tempDir);
    const consumerPath = path.join(tempDir, "consumer.ts");
    fs.writeFileSync(
      consumerPath,
      `import { createStyleRegistry, useStyleRegistry } from "styled-jsx";
import type { StyledJsxStyleRegistry } from "styled-jsx";

const registry: StyledJsxStyleRegistry = createStyleRegistry();
registry.add({ id: "consumer-style", children: "p { color: red }" });
registry.remove({ id: "consumer-style", children: "p { color: red }" });

const hookRegistry: StyledJsxStyleRegistry = useStyleRegistry();
hookRegistry.add(null);
hookRegistry.remove(null);
`,
    );

    const program = ts.createProgram(
      [
        path.resolve(import.meta.dirname, "../packages/vinext/src/types/styled-jsx.d.ts"),
        consumerPath,
      ],
      {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        strict: true,
        noEmit: true,
        skipLibCheck: false,
      },
    );
    const diagnostics = ts
      .getPreEmitDiagnostics(program)
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));

    expect(diagnostics).toEqual([]);
  });
});
