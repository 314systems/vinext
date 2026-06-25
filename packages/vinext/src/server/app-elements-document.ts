import type { AppElements, AppWireElements, UNMATCHED_SLOT } from "./app-elements-wire.js";

export const DOCUMENT_UNMATCHED_SLOT = Symbol.for("vinext.unmatchedSlot") as typeof UNMATCHED_SLOT;
const APP_UNMATCHED_SLOT_WIRE_VALUE = "__VINEXT_UNMATCHED_SLOT__";

export type DocumentAppElements = AppElements;
export type DocumentAppWireElements = AppWireElements;

function isSlotId(key: string): boolean {
  if (!key.startsWith("slot:")) return false;
  const separatorIndex = key.indexOf(":", "slot:".length);
  return separatorIndex > "slot:".length && key.charCodeAt(separatorIndex + 1) === 0x2f;
}

export function normalizeDocumentAppElements(
  elements: DocumentAppWireElements,
): DocumentAppElements {
  let normalized: Record<string, AppElements[string]> | undefined;

  for (const [key, value] of Object.entries(elements)) {
    if (!isSlotId(key) || value !== APP_UNMATCHED_SLOT_WIRE_VALUE) continue;
    normalized ??= { ...elements };
    normalized[key] = DOCUMENT_UNMATCHED_SLOT as AppElements[string];
  }

  return normalized ?? elements;
}
