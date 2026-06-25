import React from "react";
import { renderToStaticMarkup } from "react-dom/server.edge";
import { describe, expect, it } from "vite-plus/test";
import {
  MetadataHead,
  ViewportHead,
  mergeMetadata,
  renderMetadataToHtml,
  resolveModuleMetadata,
} from "../packages/vinext/src/shims/metadata-basic.js";

describe("basic metadata runtime", () => {
  it("merges title templates and descriptions", () => {
    expect(
      mergeMetadata([
        {
          title: { default: "Site", template: "%s | Site" },
          description: "Root",
        },
        { title: "Docs", description: "Page" },
      ]),
    ).toEqual({ title: "Docs | Site", description: "Page" });
  });

  it("resolves generated metadata with thenable params", async () => {
    await expect(
      resolveModuleMetadata(
        {
          async generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
            return { title: (await params).slug };
          },
        },
        { slug: "guide" },
      ),
    ).resolves.toEqual({ title: "guide" });
  });

  it("renders title and description consistently", () => {
    const metadata = { title: `A < B`, description: `quoted "value" & more` };
    expect(renderToStaticMarkup(React.createElement(MetadataHead, { metadata }))).toBe(
      '<title>A &lt; B</title><meta name="description" content="quoted &quot;value&quot; &amp; more"/>',
    );
    expect(renderMetadataToHtml(metadata)).toBe(
      '<title>A &lt; B</title><meta name="description" content="quoted &quot;value&quot; &amp; more">',
    );
  });

  it("retains complete viewport rendering", () => {
    expect(
      renderToStaticMarkup(
        React.createElement(ViewportHead, {
          viewport: {
            width: "device-width",
            initialScale: 1,
            themeColor: [{ media: "(prefers-color-scheme: dark)", color: "black" }],
            colorScheme: "light dark",
          },
        }),
      ),
    ).toContain('name="theme-color"');
  });
});
