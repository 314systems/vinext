export const APP_ROUTE_KEY = "__route";

export function readAppElementsRouteId(elements: Readonly<Record<string, unknown>>): string {
  const routeId = elements[APP_ROUTE_KEY];
  if (typeof routeId !== "string") {
    throw new Error("[vinext] Missing __route string in App Router payload");
  }
  return routeId;
}
