import { describe, expect, it, vi } from "vite-plus/test";
import { createRequireExportConditionPlugin } from "../packages/vinext/src/plugins/require-export-condition.js";

describe("require export conditions", () => {
  it("marks static package requires for require-condition resolution", () => {
    const plugin = createRequireExportConditionPlugin();
    const transform = plugin.transform as {
      handler: (code: string, id: string) => { code: string } | null;
    };

    const result = transform.handler(
      `const packageValue = require("pkg");
const relativeValue = require("./relative.js");
const dynamicValue = require(name);`,
      "/app/page.tsx",
    );

    expect(result?.code).toContain('require("virtual:vinext-require-condition:pkg")');
    expect(result?.code).toContain('require("./relative.js")');
    expect(result?.code).toContain("require(name)");
  });

  it("resolves proxies with Vite's native require-call kind", async () => {
    const plugin = createRequireExportConditionPlugin();
    const resolve = vi.fn().mockResolvedValue({ id: "/node_modules/pkg/index.cjs" });
    const resolveId = plugin.resolveId as unknown as (
      this: { resolve: typeof resolve },
      id: string,
      importer: string,
    ) => Promise<unknown>;

    await expect(
      resolveId.call(
        { resolve },
        "virtual:vinext-require-condition:%40scope%2Fpkg",
        "/app/page.tsx",
      ),
    ).resolves.toBe("/node_modules/pkg/index.cjs.vinext-require.js");
    expect(resolve).toHaveBeenCalledWith("@scope/pkg", "/app/page.tsx", {
      skipSelf: true,
      kind: "require-call",
    });
  });

  it("leaves calls alone when require is locally bound", () => {
    const plugin = createRequireExportConditionPlugin();
    const transform = plugin.transform as {
      handler: (code: string, id: string) => { code: string } | null;
    };

    expect(
      transform.handler(
        `function load(require: (id: string) => unknown) {
  return require("pkg");
}`,
        "/app/page.tsx",
      ),
    ).toBeNull();
  });
});
