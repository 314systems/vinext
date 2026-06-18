import {
  consumePrefetchResponseForNavigation,
  createCachedRscResponseSnapshot,
  createClientNavigationRenderSnapshot,
  hasPrefetchCacheEntryForNavigation,
  restoreRscResponse,
  setPendingPathname,
} from "vinext/shims/navigation";
import { consumeAppRouterScrollIntent } from "vinext/shims/app-router-scroll-state";
import { clearAppNavigationFailureTarget } from "../client/app-nav-failure-handler.js";
import type { NavigationRuntimeVisibleCommitMode } from "../client/navigation-runtime.js";
import * as appBrowserNavigationSupport from "./app-browser-navigation-support.js";
import {
  AppElementsWire,
  getMountedSlotIdsHeader,
  type AppElements,
  type AppWireElements,
} from "./app-elements.js";
import {
  FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
  VISITED_CACHE_APP_NAVIGATION_PAYLOAD_ORIGIN,
  isCacheRestorableAppPayloadMetadata,
  type AppNavigationPayloadOrigin,
  type HistoryTraversalIntent,
  type OperationLane,
} from "./app-browser-state.js";
import {
  createRscRequestHeaders,
  createRscRequestUrl,
  VINEXT_RSC_COMPATIBILITY_ID_HEADER,
  VINEXT_RSC_CONTENT_TYPE,
} from "./app-rsc-cache-busting.js";
import { APP_RSC_RENDER_MODE_REFRESH_PRESERVE_UI } from "./app-rsc-render-mode.js";
import {
  VINEXT_CLIENT_REUSE_MANIFEST_HEADER,
  VINEXT_PARAMS_HEADER,
  VINEXT_RSC_REDIRECT_HEADER,
} from "./headers.js";
import type {
  NavigationReuseFacts,
  VisitedResponseCacheCandidateFacts,
} from "./navigation-planner.js";
import type {
  HistoryUpdateMode,
  NavigationPayloadOutcome,
  PendingBrowserRouterState,
} from "./app-browser-navigation-controller.js";
import type { AppBrowserHistoryController } from "./app-browser-history-controller.js";
import type { AppRouterScrollIntent } from "vinext/shims/app-router-scroll-state";
import type { ClientNavigationRenderSnapshot } from "vinext/shims/navigation";
import type { NavigationKind } from "./app-browser-navigation-support.js";

type BrowserNavigationController = ReturnType<
  typeof import("./app-browser-navigation-controller.js").createAppBrowserNavigationController
>;
type NavigationPlanner = typeof import("./navigation-planner.js").navigationPlanner;
type DiscardedServerActionRefreshScheduler = ReturnType<
  typeof import("./app-browser-action-result.js").createDiscardedServerActionRefreshScheduler
>;

export type ClientNavigationExecutorDeps = {
  basePath: string;
  browserNavigationController: BrowserNavigationController;
  clientRscCompatibilityId: string | null;
  createFromFetch: typeof import("@vitejs/plugin-rsc/browser").createFromFetch;
  decodeAppElementsPromise(payload: Promise<AppWireElements>): Promise<AppElements>;
  discardedServerActionRefreshScheduler: DiscardedServerActionRefreshScheduler;
  getBrowserRouteManifest(): import("../routing/app-route-graph.js").RouteManifest | null;
  historyController: AppBrowserHistoryController;
  isPageUnloading(): boolean;
  navigationPlanner: NavigationPlanner;
  renderNavigationPayload(
    payload: Promise<AppElements>,
    navigationSnapshot: ClientNavigationRenderSnapshot,
    targetHref: string,
    navId: number,
    historyUpdateMode: HistoryUpdateMode | undefined,
    params: Record<string, string | string[]>,
    previousNextUrl: string | null,
    pendingRouterState: PendingBrowserRouterState | null,
    payloadOrigin: AppNavigationPayloadOrigin,
    actionType?: "navigate" | "replace" | "traverse",
    operationLane?: OperationLane,
    traversalIntent?: HistoryTraversalIntent | null,
    scrollIntent?: AppRouterScrollIntent | null,
    restoredBfcacheIds?: Readonly<Record<string, string>> | null,
    reuseCurrentBfcacheIds?: boolean,
    visibleCommitMode?: NavigationRuntimeVisibleCommitMode,
  ): Promise<NavigationPayloadOutcome>;
};

let activeNavigationAbortController: AbortController | null = null;

export async function executeClientNavigation(
  deps: ClientNavigationExecutorDeps,
  href: string,
  redirectDepth = 0,
  navigationKind: NavigationKind = "navigate",
  historyUpdateMode?: HistoryUpdateMode,
  previousNextUrlOverride?: string | null,
  programmaticTransition = false,
  traversalIntent?: HistoryTraversalIntent,
  scrollIntent?: AppRouterScrollIntent | null,
  visibleCommitMode: NavigationRuntimeVisibleCommitMode = "transition",
): Promise<void> {
  const {
    basePath,
    browserNavigationController,
    clientRscCompatibilityId,
    createFromFetch,
    discardedServerActionRefreshScheduler,
    historyController,
    navigationPlanner,
  } = deps;
  activeNavigationAbortController?.abort();
  const navigationAbortController = new AbortController();
  activeNavigationAbortController = navigationAbortController;
  let pendingRouterState: PendingBrowserRouterState | null = null;
  // Hoist navId above try so the catch and finally blocks can reference it.
  const navId = browserNavigationController.beginNavigation();
  discardedServerActionRefreshScheduler.markNavigationStart();

  // Loop variables for inline redirect following. On a redirect, these are
  // updated and the loop continues without returning or re-entering navigateRsc,
  // so a single pendingRouterState spans all hops and isPending never flashes.
  let currentHref = href;
  let currentHistoryMode = historyUpdateMode;
  let currentPrevNextUrl = previousNextUrlOverride;
  let redirectCount = redirectDepth;
  let detachedNavigationCommits = false;
  const activeTraversalIntent =
    navigationKind === "traverse"
      ? (traversalIntent ?? historyController.resolveTraversalIntent(window.history.state))
      : null;
  const performHardNavigationForScrollIntent = (targetHref: string): boolean => {
    consumeAppRouterScrollIntent(scrollIntent ?? null);
    const didNavigate = browserNavigationController.performHardNavigation(targetHref);
    if (!didNavigate) {
      clearAppNavigationFailureTarget(targetHref);
    }
    return didNavigate;
  };
  // Traversal restores history-state ids before identity matching. Any
  // redirect hop that changes currentHref must null this before commit so
  // stale ids from the pre-redirect history entry cannot win.
  // Both restoredBfcacheIds and reuseCurrentBfcacheIds are snapshotted at
  // navigation-start. If the bfcache epoch changes or a server-action
  // guard is released before the async traverse resolves, these captured
  // values may be stale — consistent with the existing restoredBfcacheIds
  // pattern, and not a regression.
  let restoredBfcacheIds =
    navigationKind === "traverse"
      ? historyController.readCurrentBfcacheVersionHistoryIds(
          activeTraversalIntent?.historyState ?? window.history.state,
        )
      : null;
  const reuseCurrentBfcacheIds =
    navigationKind !== "traverse" ||
    (!historyController.isCacheInvalidationGuarded() &&
      historyController.isCurrentBfcacheVersion(
        activeTraversalIntent?.historyState ?? window.history.state,
      ));
  try {
    const shouldUsePendingRouterState = programmaticTransition;
    if (shouldUsePendingRouterState && browserNavigationController.hasBrowserRouterState()) {
      pendingRouterState = browserNavigationController.beginPendingBrowserRouterState();
    } else {
      await browserNavigationController.waitForBrowserRouterStateReady();
      if (!browserNavigationController.isCurrentNavigation(navId)) return;

      if (shouldUsePendingRouterState) {
        pendingRouterState = browserNavigationController.beginPendingBrowserRouterState();
      }
    }

    while (true) {
      const url = new URL(currentHref, window.location.origin);
      const requestState = appBrowserNavigationSupport.getNavigationRequestState({
        basePath,
        currentPathname: window.location.pathname,
        currentPreviousNextUrl: browserNavigationController.getBrowserRouterState().previousNextUrl,
        currentSearch: window.location.search,
        navigationKind,
        previousNextUrlOverride: currentPrevNextUrl,
        routeManifest: deps.getBrowserRouteManifest(),
        targetPathname: url.pathname,
        traverseHistoryState: activeTraversalIntent?.historyState,
      });
      const requestInterceptionContext = requestState.interceptionContext;
      const requestPreviousNextUrl = requestState.previousNextUrl;
      if (navigationKind === "refresh") {
        historyController.syncCurrentHistoryStatePreviousNextUrl(
          requestPreviousNextUrl,
          browserNavigationController.getBrowserRouterState().bfcacheIds,
        );
      }

      // Set this navigation as the pending pathname, overwriting any previous.
      // Pass navId so only this navigation (or a newer one) can clear it later.
      setPendingPathname(url.pathname, navId);

      const routerStateAtNavStart = browserNavigationController.getBrowserRouterState();
      const elementsAtNavStart = routerStateAtNavStart.elements;
      const mountedSlotsHeader = getMountedSlotIdsHeader(elementsAtNavStart);
      // Next.js refetches page segments for same-page search changes even
      // when a visible Link prefetched the target. Search params are a page
      // input, so a cached full-route payload is not authoritative here.
      // Ref: packages/next/src/client/components/router-reducer/ppr-navigations.ts
      //
      // The planner owns the early-intent classification; hash-only changes are
      // already short-circuited before reaching this loop, so for a "navigate"
      // here the decision is always a flight navigation and only its
      // cache-bypass bit is consumed.
      const earlyIntentDecision =
        navigationKind === "navigate"
          ? navigationPlanner.classifyEarlyNavigationIntent({
              basePath,
              currentHref: appBrowserNavigationSupport.clientNavigationSnapshotHref(
                routerStateAtNavStart.navigationSnapshot,
              ),
              // This loop only consumes the flight-navigation cache policy;
              // hash-only intents already return before a request is queued.
              mode: "push",
              scroll: false,
              targetHref: url.href,
            })
          : null;
      const shouldBypassNavigationCache =
        earlyIntentDecision?.kind === "flightNavigation" &&
        earlyIntentDecision.bypassNavigationCache;
      // The client reuse manifest is excluded from VINEXT_RSC_VARY_HEADER, so
      // it never affects the cache-busting URL. Defer producing it until the
      // visited-response cache miss is confirmed below — its producer iterates
      // the visible layout ids and binary-searches a byte budget, which is
      // pure waste on the cache-hit soft-nav path.
      const requestHeaders = createRscRequestHeaders({
        interceptionContext: requestInterceptionContext,
        mountedSlotsHeader,
        renderMode:
          navigationKind === "refresh" ? APP_RSC_RENDER_MODE_REFRESH_PRESERVE_UI : undefined,
      });
      const rscUrl = await createRscRequestUrl(url.pathname + url.search, requestHeaders);
      const visitedResponseCandidate = shouldBypassNavigationCache
        ? {
            cacheKey: AppElementsWire.encodeCacheKey(rscUrl, requestInterceptionContext),
            entry: null,
            facts: {
              candidate: "missing",
              navigationKind,
            } satisfies Extract<VisitedResponseCacheCandidateFacts, { candidate: "missing" }>,
          }
        : appBrowserNavigationSupport.readVisitedResponseCacheCandidate(
            rscUrl,
            requestInterceptionContext,
            mountedSlotsHeader,
            navigationKind,
          );
      const visitedResponseDecision = navigationPlanner.classifyVisitedResponseCacheCandidate(
        visitedResponseCandidate.facts,
      );
      const cachedRoute = appBrowserNavigationSupport.applyVisitedResponseCacheCandidateDecision(
        visitedResponseCandidate,
        visitedResponseDecision,
      );
      const visitedResponse: NavigationReuseFacts["visitedResponse"] =
        cachedRoute === null ? { status: "unavailable" } : { status: "available" };
      const prefetchProbeDecision = navigationPlanner.classifyNavigationPrefetchProbe({
        bypassNavigationCache: shouldBypassNavigationCache,
        navigationKind,
        visitedResponse,
      });
      let routeManifest = navigationKind === "navigate" ? deps.getBrowserRouteManifest() : null;
      const hasPrefetchCandidate =
        prefetchProbeDecision.kind === "probe" &&
        hasPrefetchCacheEntryForNavigation(rscUrl, requestInterceptionContext, mountedSlotsHeader, {
          notifyInvalidation: false,
        });
      const reuseDecision = navigationPlanner.classifyNavigationReuse({
        bypassNavigationCache: shouldBypassNavigationCache,
        navigationKind,
        optimisticRouteShell:
          routeManifest === null
            ? { reason: "routeManifestMissing", status: "unavailable" }
            : { status: "available" },
        prefetch: hasPrefetchCandidate ? { status: "available" } : { status: "unavailable" },
        targetHref: currentHref,
        visitedResponse,
      });
      if (reuseDecision.kind === "reuseVisitedResponse" && cachedRoute) {
        const cachedFetchDecision = navigationPlanner.classifyRscFetchResult({
          clientCompatibilityId: clientRscCompatibilityId,
          compatibilityIdHeader: cachedRoute.response.compatibilityIdHeader ?? null,
          currentHref,
          effectiveHistoryUpdateMode: currentHistoryMode ?? "replace",
          hasBody: true,
          isRscContentType: true,
          origin: window.location.origin,
          redirectDepth: redirectCount,
          requestPreviousNextUrl,
          responseOk: true,
          responseUrl: cachedRoute.response.url,
          source: "cached",
          streamedRedirectTarget: null,
        });
        if (cachedFetchDecision.kind === "hardNavigate") {
          if (cachedFetchDecision.reason === "redirectDepthExhausted") {
            console.error(
              "[vinext] Too many RSC redirects — aborting navigation to prevent infinite loop.",
            );
          }
          performHardNavigationForScrollIntent(cachedFetchDecision.url);
          return;
        }
        if (cachedFetchDecision.kind === "followRedirect") {
          if (navigationKind === "traverse") {
            restoredBfcacheIds = null;
          }
          currentHref = cachedFetchDecision.redirect.href;
          currentHistoryMode = cachedFetchDecision.redirect.historyUpdateMode;
          currentPrevNextUrl = cachedFetchDecision.redirect.previousNextUrl;
          redirectCount = cachedFetchDecision.redirect.redirectDepth;
          continue;
        }
        // Check stale-navigation before and after createFromFetch. The pre-check
        // avoids wasted parse work; the post-check catches supersessions that
        // occur during the await. createFromFetch on a buffered response is fast
        // but still async, so the window exists. The non-cached path (below) places
        // its heavyweight async steps (fetch, body.tee + createFromFetch on the
        // live RSC branch) between navId checks consistently; the cached path omits
        // the check between createClientNavigationRenderSnapshot (synchronous) and
        // createFromFetch because there is no await in that gap.
        if (!browserNavigationController.isCurrentNavigation(navId)) return;
        const cachedParams = cachedRoute.params;
        // createClientNavigationRenderSnapshot is synchronous (URL parsing + param
        // wrapping only) — no stale-navigation recheck needed between here and the
        // next await.
        const cachedNavigationSnapshot = createClientNavigationRenderSnapshot(
          currentHref,
          cachedParams,
        );
        const cachedPayload = deps.decodeAppElementsPromise(
          createFromFetch<AppWireElements>(
            Promise.resolve(restoreRscResponse(cachedRoute.response)),
          ),
        );
        if (!browserNavigationController.isCurrentNavigation(navId)) return;
        const cachedRenderOutcome = await deps.renderNavigationPayload(
          cachedPayload,
          cachedNavigationSnapshot,
          currentHref,
          navId,
          currentHistoryMode,
          cachedParams,
          requestPreviousNextUrl,
          detachedNavigationCommits ? null : pendingRouterState,
          VISITED_CACHE_APP_NAVIGATION_PAYLOAD_ORIGIN,
          appBrowserNavigationSupport.toNavigationActionType(navigationKind),
          appBrowserNavigationSupport.toNavigationOperationLane(navigationKind),
          activeTraversalIntent,
          scrollIntent,
          restoredBfcacheIds,
          reuseCurrentBfcacheIds,
          visibleCommitMode,
        );
        if (cachedRenderOutcome === "no-commit") {
          appBrowserNavigationSupport.deleteVisitedResponse(rscUrl, requestInterceptionContext);
          continue;
        }
        return;
      }

      // Continue using the slot state captured at navigation start for fetches
      // and prefetch compatibility decisions.

      let navResponse: Response | undefined;
      let navResponseExpiresAt: number | undefined;
      let navResponseUrl: string | null = null;
      let fallbackReuseDecision = reuseDecision;
      if (reuseDecision.kind === "consumePrefetch") {
        const prefetchedResponse = await consumePrefetchResponseForNavigation(
          rscUrl,
          requestInterceptionContext,
          mountedSlotsHeader,
          {
            shouldConsume: () => browserNavigationController.isCurrentNavigation(navId),
          },
        );
        if (!browserNavigationController.isCurrentNavigation(navId)) return;
        if (prefetchedResponse) {
          navResponse = restoreRscResponse(prefetchedResponse, false);
          navResponseExpiresAt = prefetchedResponse.expiresAt;
          navResponseUrl = prefetchedResponse.url;
        }
        if (!navResponse) {
          routeManifest = navigationKind === "navigate" ? deps.getBrowserRouteManifest() : null;
          fallbackReuseDecision = navigationPlanner.classifyNavigationReuse({
            bypassNavigationCache: shouldBypassNavigationCache,
            navigationKind,
            optimisticRouteShell:
              routeManifest === null
                ? { reason: "routeManifestMissing", status: "unavailable" }
                : { status: "available" },
            prefetch: { status: "unavailable" },
            targetHref: currentHref,
            visitedResponse: { status: "unavailable" },
          });
        }
      }

      // The optimistic shell is intentionally not gated by
      // `shouldBypassNavigationCache`. A same-page search change can still
      // render an optimistic shell from cached route templates before the
      // real fetch commits, but that shell is a detached commit (see below)
      // that is always superseded by the authoritative fetch — the same as
      // cross-route navigations — so it never persists stale page content.
      if (!navResponse && fallbackReuseDecision.kind === "attemptOptimisticRouteShell") {
        await appBrowserNavigationSupport.learnOptimisticRouteTemplatesFromPrefetchCache({
          basePath: basePath,
          interceptionContext: requestInterceptionContext,
          mountedSlotsHeader,
          routeManifest,
        });
        if (!browserNavigationController.isCurrentNavigation(navId)) return;

        if (routeManifest !== null) {
          const optimisticPayload =
            appBrowserNavigationSupport.resolveOptimisticNavigationPayloadFromCache({
              basePath: basePath,
              href: currentHref,
              interceptionContext: requestInterceptionContext,
              mountedSlotsHeader,
              routeManifest,
            });

          if (optimisticPayload !== null) {
            detachedNavigationCommits = true;
            const optimisticNavigationSnapshot = createClientNavigationRenderSnapshot(
              currentHref,
              optimisticPayload.params,
            );
            // The optimistic shell is a detached commit for this navigation.
            // It uses the same navId gate as the real payload, while the real
            // payload skips pending-router-state reuse via
            // detachedNavigationCommits. That keeps late optimistic errors or
            // transitions from mutating a newer navigation or sharing mutable
            // pending state with the authoritative render.
            void deps
              .renderNavigationPayload(
                Promise.resolve(optimisticPayload.elements),
                optimisticNavigationSnapshot,
                currentHref,
                navId,
                currentHistoryMode,
                optimisticPayload.params,
                requestPreviousNextUrl,
                null,
                FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
                appBrowserNavigationSupport.toNavigationActionType(navigationKind),
                appBrowserNavigationSupport.toNavigationOperationLane(navigationKind),
                activeTraversalIntent,
                scrollIntent,
                restoredBfcacheIds,
                reuseCurrentBfcacheIds,
                visibleCommitMode,
              )
              .catch((error) => {
                if (browserNavigationController.isCurrentNavigation(navId)) {
                  console.error("[vinext] Optimistic RSC navigation error:", error);
                }
              });
          }
        }
      }

      if (!navResponse) {
        // Produce the client reuse manifest only now that prefetch/optimistic
        // paths did not satisfy the navigation and a real request is required.
        // Computed from the nav-start router state so it matches the snapshot
        // the request would have carried if produced earlier.
        if (navigationKind === "navigate") {
          const clientReuseManifestHeader =
            appBrowserNavigationSupport.createClientReuseManifestHeaderFromVisibleAppState(
              routerStateAtNavStart,
            );
          if (clientReuseManifestHeader !== null) {
            requestHeaders.set(VINEXT_CLIENT_REUSE_MANIFEST_HEADER, clientReuseManifestHeader);
          }
        }
        navResponse = await fetch(rscUrl, {
          headers: requestHeaders,
          credentials: "include",
          signal: navigationAbortController.signal,
        });
      }

      if (!browserNavigationController.isCurrentNavigation(navId)) return;

      const navContentType = navResponse.headers.get("content-type") ?? "";
      const streamedRedirectTarget = navResponse.headers.get(VINEXT_RSC_REDIRECT_HEADER);
      if (
        appBrowserNavigationSupport.blockDangerousStreamedRscRedirect(
          navResponse,
          streamedRedirectTarget,
        )
      ) {
        return;
      }
      const liveFetchDecision = navigationPlanner.classifyRscFetchResult({
        clientCompatibilityId: clientRscCompatibilityId,
        compatibilityIdHeader: navResponse.headers.get(VINEXT_RSC_COMPATIBILITY_ID_HEADER),
        currentHref,
        effectiveHistoryUpdateMode: currentHistoryMode ?? "replace",
        hasBody: navResponse.body !== null,
        isRscContentType: navContentType.startsWith(VINEXT_RSC_CONTENT_TYPE),
        origin: window.location.origin,
        redirectDepth: redirectCount,
        requestPreviousNextUrl,
        responseOk: navResponse.ok,
        responseUrl: navResponseUrl ?? navResponse.url,
        source: "live",
        streamedRedirectTarget,
      });
      if (liveFetchDecision.kind === "hardNavigate") {
        if (liveFetchDecision.discardBody) {
          void navResponse.body?.cancel().catch(() => {});
        }
        if (liveFetchDecision.reason === "redirectDepthExhausted") {
          console.error(
            "[vinext] Too many RSC redirects — aborting navigation to prevent infinite loop.",
          );
        }
        if (liveFetchDecision.reason === "streamedRedirectLoop") {
          console.error(
            "[vinext] RSC streamed redirect resolved to the current URL — aborting navigation to prevent infinite loop.",
          );
        }
        performHardNavigationForScrollIntent(liveFetchDecision.url);
        return;
      }

      if (liveFetchDecision.kind === "followRedirect") {
        if (liveFetchDecision.discardBody) {
          void navResponse.body?.cancel().catch(() => {});
        }
        if (navigationKind === "traverse") {
          restoredBfcacheIds = null;
        }
        currentHref = liveFetchDecision.redirect.href;
        currentHistoryMode = liveFetchDecision.redirect.historyUpdateMode;
        currentPrevNextUrl = liveFetchDecision.redirect.previousNextUrl;
        redirectCount = liveFetchDecision.redirect.redirectDepth;
        continue;
      }

      // navParams falls back to {} on a missing or malformed header.
      const navParams: Record<string, string | string[]> =
        appBrowserNavigationSupport.parseEncodedJsonHeader<Record<string, string | string[]>>(
          navResponse.headers.get(VINEXT_PARAMS_HEADER),
        ) ?? {};
      // Build snapshot from local params, not latestClientParams
      const navigationSnapshot = createClientNavigationRenderSnapshot(currentHref, navParams);

      // Tee the response body so React can consume it incrementally —
      // shell parses fast, and any Suspense boundary inside (e.g. the
      // route's loading.tsx) shows its fallback while the rest of the
      // RSC stream resolves. Buffering with `await response.arrayBuffer()`
      // here would block the commit until the page's slowest server
      // promise resolved, hiding the loading state entirely.
      //
      // The cache branch is read alongside React's branch, but persistence is
      // best-effort after a successful visible commit. A failed snapshot must
      // degrade future back/forward reuse, not recover by reloading the page
      // the user already reached.
      const navBody = navResponse.body;
      if (!navBody) {
        // Already validated above (`!navResponse.body` triggers a hard
        // navigation), so this branch is unreachable — kept for type
        // narrowing only.
        return;
      }
      const [reactBranch, cacheBranch] = navBody.tee();
      const reactResponse = new Response(reactBranch, {
        status: navResponse.status,
        headers: navResponse.headers,
      });
      const cacheBufferPromise = new Response(cacheBranch).arrayBuffer();
      void cacheBufferPromise.catch(() => {});

      if (!browserNavigationController.isCurrentNavigation(navId)) return;

      const rscPayload = deps.decodeAppElementsPromise(
        createFromFetch<AppWireElements>(Promise.resolve(reactResponse)),
      );

      if (!browserNavigationController.isCurrentNavigation(navId)) return;

      const renderOutcome = await deps.renderNavigationPayload(
        rscPayload,
        navigationSnapshot,
        currentHref,
        navId,
        currentHistoryMode,
        navParams,
        requestPreviousNextUrl,
        detachedNavigationCommits ? null : pendingRouterState,
        FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
        appBrowserNavigationSupport.toNavigationActionType(navigationKind),
        appBrowserNavigationSupport.toNavigationOperationLane(navigationKind),
        activeTraversalIntent,
        scrollIntent,
        restoredBfcacheIds,
        reuseCurrentBfcacheIds,
        visibleCommitMode,
      );
      if (renderOutcome !== "committed") return;
      // Don't cache the response if this navigation was superseded during
      // renderNavigationPayload's await — the elements were never dispatched.
      if (!browserNavigationController.isCurrentNavigation(navId)) return;
      // Store the visited response only after renderNavigationPayload succeeds.
      // If we stored it before and renderNavigationPayload threw, a future
      // back/forward navigation could replay a snapshot from a navigation that
      // never actually rendered successfully.
      try {
        const renderedElements = await rscPayload;
        const metadata = AppElementsWire.readMetadata(renderedElements);
        if (!isCacheRestorableAppPayloadMetadata(metadata)) {
          void cacheBufferPromise.catch(() => {});
          return;
        }
        const cacheBuffer = await cacheBufferPromise;
        appBrowserNavigationSupport.storeVisitedResponseSnapshot(
          rscUrl,
          appBrowserNavigationSupport.resolveVisitedResponseInterceptionContext(
            requestInterceptionContext,
            metadata.interceptionContext,
          ),
          {
            ...createCachedRscResponseSnapshot(navResponse, cacheBuffer, navResponseUrl),
            ...(navResponseExpiresAt !== undefined ? { expiresAt: navResponseExpiresAt } : {}),
            mountedSlotsHeader: getMountedSlotIdsHeader(renderedElements),
          },
          navParams,
        );
      } catch {
        // The visible navigation already committed. A cache snapshot failure
        // only affects future reuse; it must not reload the page.
      }
      return;
    }
  } catch (error) {
    // Don't hard-navigate to a stale URL if this navigation was superseded by
    // a newer one — the newer navigation is already in flight and would be clobbered.
    if (!browserNavigationController.isCurrentNavigation(navId)) return;
    // Suppress the diagnostic when the page is unloading: a hard-nav or anchor
    // click tears down the document and aborts any in-flight RSC fetch, which
    // surfaces here as an error. The page is already going away, so the log
    // is just noise. Mirrors Next.js' isPageUnloading pattern.
    if (!deps.isPageUnloading()) {
      console.error("[vinext] RSC navigation error:", error);
    }
    const errorDecision = navigationPlanner.classifyRscNavigationError({
      currentHref,
    });
    performHardNavigationForScrollIntent(errorDecision.url);
  } finally {
    if (activeNavigationAbortController === navigationAbortController) {
      activeNavigationAbortController = null;
    }
    // Single settlement site: covers normal return, early returns on stale-id
    // checks, and error paths. The finally runs even when the catch returns.
    // settlePendingBrowserRouterState is idempotent via the settled flag.
    browserNavigationController.finalizeNavigation(navId, pendingRouterState);
    discardedServerActionRefreshScheduler.markNavigationSettled();
  }
}
