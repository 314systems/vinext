import { describe, expect, it } from "vite-plus/test";
import {
  DOCUMENT_UNMATCHED_SLOT,
  normalizeDocumentAppElements,
} from "../packages/vinext/src/server/app-elements-document.js";

describe("document App Elements", () => {
  it("returns payloads without unmatched slots unchanged", () => {
    const elements = { "route:/": "page" };

    expect(normalizeDocumentAppElements(elements)).toBe(elements);
  });

  it("normalizes only unmatched slot wire sentinels", () => {
    const elements = {
      "route:/": "__VINEXT_UNMATCHED_SLOT__",
      "slot:children:/": "__VINEXT_UNMATCHED_SLOT__",
    };

    expect(normalizeDocumentAppElements(elements)).toEqual({
      "route:/": "__VINEXT_UNMATCHED_SLOT__",
      "slot:children:/": DOCUMENT_UNMATCHED_SLOT,
    });
  });
});
