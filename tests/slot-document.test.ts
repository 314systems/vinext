import React from "react";
import { renderToReadableStream } from "react-dom/server.edge";
import { describe, expect, it } from "vite-plus/test";
import * as slot from "../packages/vinext/src/shims/slot-document.js";

async function renderHtml(element: React.ReactElement): Promise<string> {
  const stream = await renderToReadableStream(element);
  await stream.allReady;
  return new Response(stream).text();
}

describe("document-only slot primitives", () => {
  it("renders matched elements with children and parallel slot providers", async () => {
    function Layout() {
      return React.createElement(
        "main",
        null,
        React.createElement(slot.Children),
        React.createElement(slot.ParallelSlot, { name: "modal" }),
      );
    }

    const html = await renderHtml(
      React.createElement(
        slot.ElementsContext.Provider,
        { value: { "layout:/": React.createElement(Layout) } },
        React.createElement(
          slot.Slot,
          {
            id: "layout:/",
            parallelSlots: { modal: React.createElement("aside", null, "modal") },
          },
          React.createElement("p", null, "child"),
        ),
      ),
    );

    expect(html).toContain("child");
    expect(html).toContain("modal");
  });

  it("returns null for absent and present null entries", async () => {
    const absent = await renderHtml(
      React.createElement(
        slot.ElementsContext.Provider,
        { value: {} },
        React.createElement(slot.Slot, { id: "slot:modal:/" }),
      ),
    );
    const presentNull = await renderHtml(
      React.createElement(
        slot.ElementsContext.Provider,
        { value: { "slot:modal:/": null } },
        React.createElement(slot.Slot, { id: "slot:modal:/" }),
      ),
    );

    expect(absent).toBe("");
    expect(presentNull).toBe("");
  });

  it("throws the not-found signal for unmatched slots", async () => {
    const consoleError = console.error;
    console.error = () => {};
    try {
      await expect(
        renderHtml(
          React.createElement(
            slot.ElementsContext.Provider,
            { value: { "slot:modal:/": slot.UNMATCHED_SLOT } },
            React.createElement(slot.Slot, { id: "slot:modal:/" }),
          ),
        ),
      ).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
    } finally {
      console.error = consoleError;
    }
  });
});
