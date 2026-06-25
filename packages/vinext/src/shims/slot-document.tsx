"use client";

import * as React from "react";
import {
  DOCUMENT_UNMATCHED_SLOT,
  type DocumentAppElements,
} from "../server/app-elements-document.js";
import { notFound } from "./navigation-errors.js";

const EMPTY_ELEMENTS: DocumentAppElements = Object.freeze({});
const EMPTY_BFCACHE_STATE_KEYS: Readonly<Record<string, string>> = Object.freeze({});

export { DOCUMENT_UNMATCHED_SLOT as UNMATCHED_SLOT };

export const ElementsContext = React.createContext<DocumentAppElements>(EMPTY_ELEMENTS);
export const ChildrenContext = React.createContext<React.ReactNode>(null);
export const ParallelSlotsContext = React.createContext<Readonly<
  Record<string, React.ReactNode>
> | null>(null);
export const BfcacheStateKeyMapContext =
  React.createContext<Readonly<Record<string, string>>>(EMPTY_BFCACHE_STATE_KEYS);

/**
 * Initial document rendering does not merge navigation payloads or retain
 * previous segments, so it only needs direct element lookup and child wiring.
 */
export function Slot({
  id,
  children,
  parallelSlots,
}: {
  id: string;
  children?: React.ReactNode;
  parallelSlots?: Readonly<Record<string, React.ReactNode>>;
}) {
  const elements = React.useContext(ElementsContext);
  if (!Object.hasOwn(elements, id)) return null;

  const element = elements[id];
  if (element === DOCUMENT_UNMATCHED_SLOT) notFound();
  if (element === null) return null;

  return (
    <ParallelSlotsContext.Provider value={parallelSlots ?? null}>
      <ChildrenContext.Provider value={children ?? null}>
        {element as React.ReactNode}
      </ChildrenContext.Provider>
    </ParallelSlotsContext.Provider>
  );
}

export function Children() {
  return React.useContext(ChildrenContext);
}

export function ParallelSlot({ name }: { name: string }) {
  const slots = React.useContext(ParallelSlotsContext);
  return slots?.[name] ?? null;
}
