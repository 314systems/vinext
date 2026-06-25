import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { metadataModuleCanUseBasicRuntime } from "../packages/vinext/src/build/app-metadata-capabilities.js";

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-metadata-capabilities-"));
let fixtureIndex = 0;

function inspect(source: string, extension = "tsx"): boolean {
  const filePath = path.join(fixtureDir, `module-${fixtureIndex++}.${extension}`);
  fs.writeFileSync(filePath, source);
  return metadataModuleCanUseBasicRuntime(filePath);
}

afterAll(() => {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

describe("App metadata capabilities", () => {
  it("accepts modules without metadata exports", () => {
    expect(inspect("export default function Page() { return null }")).toBe(true);
  });

  it("accepts static title and description metadata", () => {
    expect(
      inspect(`
export const metadata = {
  title: { default: "Docs", template: "%s | Site" },
  description: "Documentation",
} satisfies Metadata;
`),
    ).toBe(true);
  });

  it("accepts generateMetadata object returns with basic fields", () => {
    expect(
      inspect(`
export async function generateMetadata({ params }) {
  if ((await params).slug === "docs") return { title: "Docs" };
  return { title: "Other", description: "Description" };
}
`),
    ).toBe(true);
  });

  it("accepts generateMetadata arrow functions", () => {
    expect(inspect(`export const generateMetadata = () => ({ title: "Page" });`)).toBe(true);
  });

  it("rejects advanced static metadata", () => {
    expect(inspect(`export const metadata = { title: "Page", openGraph: { title: "OG" } };`)).toBe(
      false,
    );
  });

  it("rejects advanced generated metadata", () => {
    expect(inspect(`export function generateMetadata() { return { robots: "noindex" }; }`)).toBe(
      false,
    );
  });

  it("rejects spreads and indirect metadata exports", () => {
    expect(inspect(`export const metadata = { title: "Page", ...shared };`)).toBe(false);
    expect(inspect(`const metadata = createMetadata(); export { metadata };`)).toBe(false);
    expect(inspect(`export * from "./metadata";`)).toBe(false);
  });

  it("fails closed when generated metadata does not return an object literal", () => {
    expect(inspect(`export function generateMetadata() { return createMetadata(); }`)).toBe(false);
  });
});
