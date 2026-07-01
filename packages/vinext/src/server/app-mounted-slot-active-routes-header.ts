/**
 * Normalize the active-route side channel for mounted App Router slots.
 *
 * The browser sends this only for refresh/action rerender requests where the
 * server must refresh a preserved parallel slot that is not part of the target
 * route. The wire format is space-separated, URL-encoded `slotId=routeId`
 * pairs sorted by slot id.
 */

import { AppElementsWire, type AppElementsSlotBinding } from "./app-elements-wire.js";

const MAX_RAW_HEADER_LENGTH = 4096;
const MAX_PAIR_LENGTH = 512;
const MAX_SLOT_TOKENS = 16;

function isRouteId(value: string): boolean {
  return AppElementsWire.parseElementKey(value)?.kind === "route";
}

function decodePairToken(token: string): readonly [string, string] | null {
  if (!token || token.length > MAX_PAIR_LENGTH) return null;
  const separator = token.indexOf("=");
  if (separator <= 0 || separator === token.length - 1) return null;

  try {
    const slotId = decodeURIComponent(token.slice(0, separator));
    const routeId = decodeURIComponent(token.slice(separator + 1));
    if (!AppElementsWire.isSlotId(slotId) || !isRouteId(routeId)) return null;
    return [slotId, routeId];
  } catch {
    return null;
  }
}

function encodePair(slotId: string, routeId: string): string {
  return `${encodeURIComponent(slotId)}=${encodeURIComponent(routeId)}`;
}

export function normalizeMountedSlotActiveRoutesHeader(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;
  if (raw.length > MAX_RAW_HEADER_LENGTH) return null;

  const pairs = new Map<string, string>();
  for (const token of raw.split(/\s+/)) {
    const pair = decodePairToken(token);
    if (pair === null) continue;
    pairs.set(pair[0], pair[1]);
  }
  if (pairs.size === 0) return null;

  const normalized = Array.from(pairs.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, MAX_SLOT_TOKENS)
    .map(([slotId, routeId]) => encodePair(slotId, routeId))
    .join(" ");
  return normalized || null;
}

export function parseMountedSlotActiveRoutesHeader(
  raw: string | null | undefined,
): ReadonlyMap<string, string> | null {
  const normalized = normalizeMountedSlotActiveRoutesHeader(raw);
  if (normalized === null) return null;

  const pairs = new Map<string, string>();
  for (const token of normalized.split(" ")) {
    const pair = decodePairToken(token);
    if (pair !== null) pairs.set(pair[0], pair[1]);
  }
  return pairs.size > 0 ? pairs : null;
}

export function createMountedSlotActiveRoutesHeader(
  slotBindings: readonly AppElementsSlotBinding[],
): string | null {
  const pairs: string[] = [];
  for (const binding of slotBindings) {
    if (binding.state !== "active" || !binding.activeRouteId) continue;
    if (!AppElementsWire.isSlotId(binding.slotId) || !isRouteId(binding.activeRouteId)) continue;
    pairs.push(encodePair(binding.slotId, binding.activeRouteId));
  }
  return normalizeMountedSlotActiveRoutesHeader(pairs.join(" "));
}
