import {
  getNavigationRuntime,
  loadNavigationRuntimeRouteManifest,
  type NavigationRuntimeVisibleCommitMode,
} from "../client/navigation-runtime.js";
import {
  getClientNavigationPlannerModule,
  loadClientNavigationPlannerModule,
} from "../client/navigation-planner-runtime.js";
import { notifyAppRouterTransitionStart } from "../client/instrumentation-client-state.js";
import {
  clearAppNavigationFailureTarget,
  stageAppNavigationFailureTarget,
} from "../client/app-nav-failure-handler.js";
import { createAppPayloadCacheKey } from "../server/app-elements.js";
import { createHashOnlyHistoryStatePreservingNavigationMetadata } from "../server/app-history-state.js";
import { hasPendingAppRouterPageRedirect } from "../server/app-browser-mpa-navigation.js";
import { createRscRequestHeaders, createRscRequestUrl } from "../server/app-rsc-cache-busting.js";
import { VINEXT_MOUNTED_SLOTS_HEADER } from "../server/headers.js";
import {
  isAbsoluteOrProtocolRelativeUrl,
  toBrowserNavigationHref,
  toSameOriginAppPath,
} from "./url-utils.js";
import { resolveHybridClientRouteOwner } from "./internal/hybrid-client-route-owner.js";
import { scrollToHashTarget } from "./hash-scroll.js";
import {
  beginAppRouterScrollIntent,
  clearAppRouterScrollIntent,
  consumeAppRouterScrollIntent,
  getPendingAppRouterScrollIntent,
  type AppRouterScrollIntent,
} from "./app-router-scroll-state.js";
import {
  __basePath,
  applyAppRouterScrollFallback,
  attachPrefetchInvalidationCallback,
  commitClientNavigationState,
  getMountedSlotsHeader,
  getPrefetchInterceptionContext,
  getPrefetchedUrls,
  prefetchRscResponse,
  pushHistoryStateWithoutNotify,
  replaceHistoryStateWithoutNotify,
  saveScrollPosition,
  type PrefetchOptions,
} from "./navigation.js";

function commitHashOnlyHistoryState(href: string, mode: "push" | "replace", scroll: boolean): void {
  const commitAppRouterHashNavigation = getNavigationRuntime()?.functions.commitHashNavigation;
  if (commitAppRouterHashNavigation) {
    commitAppRouterHashNavigation(href, mode, scroll);
    return;
  }

  const historyState = createHashOnlyHistoryStatePreservingNavigationMetadata(window.history.state);
  if (mode === "replace") {
    replaceHistoryStateWithoutNotify(historyState, "", href);
  } else {
    pushHistoryStateWithoutNotify(historyState, "", href);
  }
}

function scheduleAppRouterScrollFallback(intent: AppRouterScrollIntent): void {
  queueMicrotask(() => {
    const pendingIntent = getPendingAppRouterScrollIntent();
    if (pendingIntent === null || pendingIntent.id !== intent.id) return;
    const fallbackIntent = consumeAppRouterScrollIntent(intent);
    if (fallbackIntent) applyAppRouterScrollFallback(fallbackIntent);
  });
}

function hardNavigateTo(fullHref: string, mode: "push" | "replace"): void {
  if (mode === "replace") {
    window.location.replace(fullHref);
  } else {
    window.location.assign(fullHref);
  }
}

export async function navigateClientSide(
  href: string,
  mode: "push" | "replace",
  scroll: boolean,
  programmaticTransition = false,
  visibleCommitMode: NavigationRuntimeVisibleCommitMode = "transition",
): Promise<void> {
  getNavigationRuntime()?.functions.notifyLinkNavigationStart?.();

  let normalizedHref = href;
  if (isAbsoluteOrProtocolRelativeUrl(href)) {
    const localPath = toSameOriginAppPath(href, __basePath);
    if (localPath == null) {
      notifyAppRouterTransitionStart(href, mode);
      const externalNavigate = getNavigationRuntime()?.functions.navigateExternal;
      if (externalNavigate) {
        await externalNavigate(href, mode);
        return;
      }
      hardNavigateTo(href, mode);
      await new Promise<void>(() => {});
      return;
    }
    normalizedHref = localPath;
  }

  const hybridOwner = resolveHybridClientRouteOwner(normalizedHref, __basePath);
  if (hybridOwner === "pages" || hybridOwner === "document") {
    const fullHref = toBrowserNavigationHref(normalizedHref, window.location.href, __basePath);
    notifyAppRouterTransitionStart(fullHref, mode);
    if (mode === "push") saveScrollPosition();
    hardNavigateTo(fullHref, mode);
    await new Promise<void>(() => {});
    return;
  }

  const fullHref = toBrowserNavigationHref(normalizedHref, window.location.href, __basePath);
  stageAppNavigationFailureTarget(fullHref);
  notifyAppRouterTransitionStart(fullHref, mode);
  if (mode === "push") saveScrollPosition();

  await loadClientNavigationPlannerModule();
  const navigationPlanner = getClientNavigationPlannerModule().navigationPlanner;
  const earlyIntent = navigationPlanner.classifyEarlyNavigationIntent({
    basePath: __basePath,
    currentHref: window.location.href,
    mode,
    scroll,
    targetHref: fullHref,
  });
  if (earlyIntent.kind === "sameDocumentScroll") {
    clearAppRouterScrollIntent();
    commitHashOnlyHistoryState(fullHref, earlyIntent.mode, earlyIntent.scroll);
    clearAppNavigationFailureTarget(fullHref);
    commitClientNavigationState();
    if (earlyIntent.scroll) scrollToHashTarget(earlyIntent.hash);
    return;
  }

  if (hasPendingAppRouterPageRedirect(typeof document === "undefined" ? undefined : document)) {
    const mpaNavigate = getNavigationRuntime()?.functions.navigateExternal;
    if (mpaNavigate) {
      await mpaNavigate(fullHref, mode);
      return;
    }
    hardNavigateTo(fullHref, mode);
    await new Promise<void>(() => {});
    return;
  }

  const hashIdx = fullHref.indexOf("#");
  const hash = hashIdx !== -1 ? fullHref.slice(hashIdx) : "";
  const scrollIntent = scroll ? beginAppRouterScrollIntent(hash || null) : null;
  if (!scroll) clearAppRouterScrollIntent();

  const appNavigate = getNavigationRuntime()?.functions.navigate;
  try {
    if (appNavigate) {
      await appNavigate(
        fullHref,
        0,
        "navigate",
        mode,
        undefined,
        programmaticTransition,
        undefined,
        scrollIntent,
        visibleCommitMode,
      );
    } else {
      if (mode === "replace") {
        replaceHistoryStateWithoutNotify(null, "", fullHref);
      } else {
        pushHistoryStateWithoutNotify(null, "", fullHref);
      }
      commitClientNavigationState();
    }
  } catch (error) {
    if (scrollIntent) consumeAppRouterScrollIntent(scrollIntent);
    throw error;
  }

  if (scrollIntent) scheduleAppRouterScrollFallback(scrollIntent);
}

export async function prefetchAppRoute(href: string, options?: PrefetchOptions): Promise<void> {
  let prefetchHref = href;
  if (isAbsoluteOrProtocolRelativeUrl(href)) {
    const localPath = toSameOriginAppPath(href, __basePath);
    if (localPath == null) return;
    prefetchHref = localPath;
  }

  const hybridOwner = resolveHybridClientRouteOwner(prefetchHref, __basePath);
  if (hybridOwner === "pages" || hybridOwner === "document") return;

  const fullHref = toBrowserNavigationHref(prefetchHref, window.location.href, __basePath);
  await loadNavigationRuntimeRouteManifest();
  const interceptionContext = getPrefetchInterceptionContext(fullHref);
  const mountedSlotsHeader = getMountedSlotsHeader();
  const headers = createRscRequestHeaders({ interceptionContext });
  if (mountedSlotsHeader) headers.set(VINEXT_MOUNTED_SLOTS_HEADER, mountedSlotsHeader);
  const rscUrl = await createRscRequestUrl(fullHref, headers);
  const cacheKey = createAppPayloadCacheKey(rscUrl, interceptionContext);
  const prefetched = getPrefetchedUrls();
  if (prefetched.has(cacheKey)) {
    attachPrefetchInvalidationCallback(cacheKey, options?.onInvalidate);
    return;
  }
  prefetched.add(cacheKey);
  prefetchRscResponse(
    rscUrl,
    fetch(rscUrl, {
      headers,
      credentials: "include",
      priority: "low" as RequestInit["priority"],
    }),
    interceptionContext,
    mountedSlotsHeader,
    options,
  );
}
