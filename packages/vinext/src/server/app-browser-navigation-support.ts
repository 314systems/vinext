import { createFromFetch } from "@vitejs/plugin-rsc/browser";
import {
  createSnapshotPathAndSearch,
  getPrefetchCache,
  resolvePrefetchCacheEntryMountedSlotsHeader,
  restoreRscResponse,
  type CachedRscResponse,
  type ClientNavigationRenderSnapshot,
  type PrefetchCacheEntry,
} from "vinext/shims/navigation";
import type { RouteManifest } from "../routing/app-route-graph.js";
import {
  createOptimisticRouteTemplate,
  getOptimisticPrefetchSourceKey,
  getOptimisticRouteTemplateKey,
  resolveOptimisticNavigationPayload,
  type OptimisticRouteTemplate,
} from "./app-optimistic-routing.js";
import {
  normalizeAppElements,
  createAppPayloadCacheKey,
  resolveVisitedResponseInterceptionContext,
  type AppWireElements,
} from "./app-elements.js";
import {
  resolveManifestNavigationInterceptionContext,
  resolveMiddlewareRewriteNavigationInterceptionContext,
} from "./app-browser-interception-context.js";
import {
  createVisitedResponseCacheEntry,
  isVisitedResponseCacheEntryFresh,
  type VisitedResponseCacheEntry,
} from "./app-visited-response-cache.js";
import {
  readHistoryStatePreviousNextUrl,
  resolveInterceptionContextFromPreviousNextUrl,
} from "./app-browser-state.js";
import type { OperationLane, VisitedResponseCacheCandidateFacts } from "./navigation-planner.js";

export { blockDangerousStreamedRscRedirect } from "./app-browser-rsc-redirect.js";
export { createClientReuseManifestHeaderFromVisibleAppState } from "./app-browser-client-reuse-manifest.js";
export {
  createOptimisticRouteTemplate,
  getOptimisticPrefetchSourceKey,
  getOptimisticRouteTemplateKey,
  resolveManifestNavigationInterceptionContext,
  resolveMiddlewareRewriteNavigationInterceptionContext,
  resolveOptimisticNavigationPayload,
  resolveVisitedResponseInterceptionContext,
  type OptimisticRouteTemplate,
};
export { createVisitedResponseCacheEntry, isVisitedResponseCacheEntryFresh };

export type NavigationKind = "navigate" | "traverse" | "refresh";

export type VisitedResponseCacheCandidate =
  | {
      cacheKey: string;
      entry: VisitedResponseCacheEntry;
      facts: Extract<VisitedResponseCacheCandidateFacts, { candidate: "present" }>;
    }
  | {
      cacheKey: string;
      entry: null;
      facts: Extract<VisitedResponseCacheCandidateFacts, { candidate: "missing" }>;
    };

const MAX_VISITED_RESPONSE_CACHE_SIZE = 50;
const optimisticRouteTemplates = new Map<string, OptimisticRouteTemplate>();
const optimisticRouteTemplateSources = new Set<string>();
const optimisticRouteTemplateLearning = new Map<string, Promise<void>>();
const visitedResponseCache = new Map<string, VisitedResponseCacheEntry>();

export function clearAppBrowserNavigationState(): void {
  optimisticRouteTemplates.clear();
  optimisticRouteTemplateSources.clear();
  optimisticRouteTemplateLearning.clear();
  visitedResponseCache.clear();
}

function isSettledPrefetchCacheEntry(
  entry: PrefetchCacheEntry,
): entry is PrefetchCacheEntry & { snapshot: CachedRscResponse } {
  return (
    entry.outcome === "cache-seeded" && entry.pending === undefined && entry.snapshot !== undefined
  );
}

function parsePrefetchCacheKey(cacheKey: string): {
  interceptionContext: string | null;
  rscUrl: string;
} {
  const separatorIndex = cacheKey.indexOf("\0");
  if (separatorIndex === -1) {
    return { interceptionContext: null, rscUrl: cacheKey };
  }
  return {
    interceptionContext: cacheKey.slice(separatorIndex + 1),
    rscUrl: cacheKey.slice(0, separatorIndex),
  };
}

async function learnOptimisticRouteTemplateFromPrefetch(options: {
  basePath: string;
  cacheKey: string;
  entry: PrefetchCacheEntry & { snapshot: CachedRscResponse };
  interceptionContext: string | null;
  mountedSlotsHeader: string | null;
  routeManifest: RouteManifest;
}): Promise<boolean> {
  const source = parsePrefetchCacheKey(options.cacheKey);
  if (source.interceptionContext !== options.interceptionContext) return false;
  if (resolvePrefetchCacheEntryMountedSlotsHeader(options.entry) !== options.mountedSlotsHeader) {
    return false;
  }
  if (options.interceptionContext !== null) return false;

  const wireElements = await createFromFetch<AppWireElements>(
    Promise.resolve(restoreRscResponse(options.entry.snapshot)),
  );
  const template = createOptimisticRouteTemplate({
    allowLoadingShell: options.entry.optimisticRouteShell === true,
    basePath: options.basePath,
    elements: normalizeAppElements(wireElements),
    href: options.entry.snapshot.url || source.rscUrl,
    interceptionContext: options.interceptionContext,
    mountedSlotsHeader: options.mountedSlotsHeader,
    routeManifest: options.routeManifest,
  });
  if (template === null) return false;

  optimisticRouteTemplates.set(
    getOptimisticRouteTemplateKey({
      interceptionContext: options.interceptionContext,
      mountedSlotsHeader: options.mountedSlotsHeader,
      routeId: template.routeId,
    }),
    template,
  );
  return true;
}

export async function learnOptimisticRouteTemplatesFromPrefetchCache(options: {
  basePath: string;
  interceptionContext: string | null;
  mountedSlotsHeader: string | null;
  routeManifest: RouteManifest | null;
}): Promise<void> {
  if (options.routeManifest === null) return;

  const learning: Promise<void>[] = [...optimisticRouteTemplateLearning.values()];
  for (const [cacheKey, entry] of getPrefetchCache()) {
    const sourceKey = getOptimisticPrefetchSourceKey({
      cacheKey,
      interceptionContext: options.interceptionContext,
      mountedSlotsHeader: options.mountedSlotsHeader,
    });
    if (optimisticRouteTemplateSources.has(sourceKey)) continue;
    if (optimisticRouteTemplateLearning.has(sourceKey)) continue;
    if (!isSettledPrefetchCacheEntry(entry)) continue;

    const promise = learnOptimisticRouteTemplateFromPrefetch({
      basePath: options.basePath,
      cacheKey,
      entry,
      interceptionContext: options.interceptionContext,
      mountedSlotsHeader: options.mountedSlotsHeader,
      routeManifest: options.routeManifest,
    })
      .then((learned) => {
        if (learned) optimisticRouteTemplateSources.add(sourceKey);
      })
      .finally(() => {
        optimisticRouteTemplateLearning.delete(sourceKey);
      });
    optimisticRouteTemplateLearning.set(sourceKey, promise);
    learning.push(promise);
  }

  if (learning.length === 0) return;
  await Promise.allSettled(learning);
}

export function resolveOptimisticNavigationPayloadFromCache(options: {
  basePath: string;
  href: string;
  interceptionContext: string | null;
  mountedSlotsHeader: string | null;
  routeManifest: RouteManifest;
}) {
  return resolveOptimisticNavigationPayload({
    ...options,
    templates: optimisticRouteTemplates,
  });
}

export function readVisitedResponseCacheCandidate(
  rscUrl: string,
  interceptionContext: string | null,
  mountedSlotsHeader: string | null,
  navigationKind: NavigationKind,
): VisitedResponseCacheCandidate {
  const cacheKey = createAppPayloadCacheKey(rscUrl, interceptionContext);
  const cached = visitedResponseCache.get(cacheKey);
  if (!cached) {
    return {
      cacheKey,
      entry: null,
      facts: {
        candidate: "missing",
        navigationKind,
      },
    };
  }

  return {
    cacheKey,
    entry: cached,
    facts: {
      candidate: "present",
      fresh: isVisitedResponseCacheEntryFresh(cached, {
        navigationKind,
        now: Date.now(),
      }),
      mountedSlotsMatch: (cached.response.mountedSlotsHeader ?? null) === mountedSlotsHeader,
      navigationKind,
    },
  };
}

export function applyVisitedResponseCacheCandidateDecision(
  candidate: VisitedResponseCacheCandidate,
  decision: ReturnType<
    typeof import("./navigation-planner.js").navigationPlanner.classifyVisitedResponseCacheCandidate
  >,
): VisitedResponseCacheEntry | null {
  if (candidate.entry === null) return null;

  if (decision.kind === "reuse") {
    visitedResponseCache.delete(candidate.cacheKey);
    visitedResponseCache.set(candidate.cacheKey, candidate.entry);
    return candidate.entry;
  }

  visitedResponseCache.delete(candidate.cacheKey);
  return null;
}

export function deleteVisitedResponse(rscUrl: string, interceptionContext: string | null): void {
  visitedResponseCache.delete(createAppPayloadCacheKey(rscUrl, interceptionContext));
}

export function storeVisitedResponseSnapshot(
  rscUrl: string,
  interceptionContext: string | null,
  snapshot: CachedRscResponse,
  params: Record<string, string | string[]>,
): void {
  const cacheKey = createAppPayloadCacheKey(rscUrl, interceptionContext);
  visitedResponseCache.delete(cacheKey);
  while (visitedResponseCache.size >= MAX_VISITED_RESPONSE_CACHE_SIZE) {
    const oldest = visitedResponseCache.keys().next().value;
    if (oldest === undefined) break;
    visitedResponseCache.delete(oldest);
  }
  const now = Date.now();
  visitedResponseCache.set(
    cacheKey,
    createVisitedResponseCacheEntry({
      now,
      params,
      response: snapshot,
    }),
  );
}

export function clientNavigationSnapshotHref(snapshot: ClientNavigationRenderSnapshot): string {
  return `${window.location.origin}${createSnapshotPathAndSearch(snapshot)}`;
}

export function parseEncodedJsonHeader<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(decodeURIComponent(value)) as T;
  } catch {
    return null;
  }
}

export function getNavigationRequestState(options: {
  basePath: string;
  currentPathname: string;
  currentSearch: string;
  currentPreviousNextUrl: string | null;
  navigationKind: NavigationKind;
  previousNextUrlOverride?: string | null;
  routeManifest: RouteManifest | null;
  targetPathname: string;
  traverseHistoryState?: unknown;
}): {
  interceptionContext: string | null;
  previousNextUrl: string | null;
} {
  if (options.previousNextUrlOverride !== undefined) {
    return {
      interceptionContext: resolveInterceptionContextFromPreviousNextUrl(
        options.previousNextUrlOverride,
        options.basePath,
      ),
      previousNextUrl: options.previousNextUrlOverride,
    };
  }

  switch (options.navigationKind) {
    case "navigate": {
      if (options.currentPreviousNextUrl !== null) {
        return {
          interceptionContext: resolveInterceptionContextFromPreviousNextUrl(
            options.currentPreviousNextUrl,
            options.basePath,
          ),
          previousNextUrl: options.currentPreviousNextUrl,
        };
      }
      const manifestInterceptionContext = resolveManifestNavigationInterceptionContext({
        basePath: options.basePath,
        currentPathname: options.currentPathname,
        routeManifest: options.routeManifest,
        targetPathname: options.targetPathname,
      });
      if (manifestInterceptionContext !== null) {
        return {
          interceptionContext: manifestInterceptionContext,
          previousNextUrl: options.currentPathname + options.currentSearch,
        };
      }
      const middlewareRewriteInterceptionContext =
        resolveMiddlewareRewriteNavigationInterceptionContext({
          basePath: options.basePath,
          currentPathname: options.currentPathname,
          routeManifest: options.routeManifest,
          targetPathname: options.targetPathname,
        });
      if (middlewareRewriteInterceptionContext !== null) {
        return {
          interceptionContext: middlewareRewriteInterceptionContext,
          previousNextUrl: options.currentPathname + options.currentSearch,
        };
      }
      return {
        interceptionContext: null,
        previousNextUrl: null,
      };
    }
    case "traverse": {
      const previousNextUrl = readHistoryStatePreviousNextUrl(
        options.traverseHistoryState ?? window.history.state,
      );
      return {
        interceptionContext: resolveInterceptionContextFromPreviousNextUrl(
          previousNextUrl,
          options.basePath,
        ),
        previousNextUrl,
      };
    }
    case "refresh":
      return {
        interceptionContext: resolveInterceptionContextFromPreviousNextUrl(
          options.currentPreviousNextUrl,
          options.basePath,
        ),
        previousNextUrl: options.currentPreviousNextUrl,
      };
  }
}

export function toNavigationActionType(kind: NavigationKind): "navigate" | "traverse" {
  return kind === "traverse" ? "traverse" : "navigate";
}

export function toNavigationOperationLane(kind: NavigationKind): OperationLane {
  switch (kind) {
    case "navigate":
      return "navigation";
    case "refresh":
      return "refresh";
    case "traverse":
      return "traverse";
  }
}
