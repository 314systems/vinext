/// <reference types="vite/client" />

import {
  createElement,
  startTransition,
  use,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  createFromFetch,
  createFromReadableStream,
  setServerCallback,
} from "@vitejs/plugin-rsc/browser";
import { createRoot, hydrateRoot } from "react-dom/client";
import "../client/instrumentation-client.js";
import {
  __basePath,
  appRouterInstance,
  commitClientNavigationState,
  createClientNavigationRenderSnapshot,
  getClientNavigationRenderContext,
  getBfcacheIdMapContext,
  invalidatePrefetchCache,
  decodeRedirectError,
  isRedirectError,
  pushHistoryStateWithoutNotify,
  replaceClientParamsWithoutNotify,
  replaceHistoryStateWithoutNotify,
  saveScrollPosition,
  setClientParams,
  setMountedSlotsHeader,
  setNavigationContext,
  useRouter,
  type ClientNavigationRenderSnapshot,
} from "vinext/shims/navigation";
import {
  getNavigationRuntime,
  loadNavigationRuntimeRouteManifest,
  registerNavigationRuntimeBootstrap,
  registerNavigationRuntimeFunctions,
  type NavigationRuntimeNavigate,
  type NavigationRuntimeVisibleCommitMode,
  type NavigationRuntimeRscBootstrap,
} from "../client/navigation-runtime.js";
import {
  getClientNavigationPlannerModule,
  isClientNavigationPlannerModuleLoaded,
  loadClientNavigationPlannerModule,
} from "../client/navigation-planner-runtime.js";
import { AppRouterScrollCommitProvider } from "vinext/shims/app-router-scroll";
import {
  beginAppRouterScrollIntent,
  type AppRouterScrollIntent,
} from "vinext/shims/app-router-scroll-state";
import { installWindowNext, setWindowNextInternalSourcePage } from "../client/window-next.js";
import {
  chunksToReadableStream,
  createProgressiveRscStream,
  getVinextBrowserGlobal,
} from "./app-browser-stream.js";
import {
  clearHardNavigationLoopGuard,
  createAppBrowserNavigationController,
  type HistoryUpdateMode,
  type NavigationPayloadOutcome,
  type PendingBrowserRouterState,
} from "./app-browser-navigation-controller.js";
import { AppBrowserMpaNavigationScheduler } from "./app-browser-mpa-navigation.js";
import {
  createDiscardedServerActionRefreshScheduler,
  createServerActionInitiationSnapshot,
  type ServerActionRevalidationKind,
  type AppBrowserServerActionResult,
} from "./app-browser-action-result.js";
import {
  consumeInitialFormState,
  createVinextHydrateRootOptions,
  hydrateRootInTransition,
} from "./app-browser-hydration.js";
import {
  AppElementsWire,
  getMountedSlotIdsHeader,
  type AppElements,
  type AppWireElements,
} from "./app-elements.js";
import {
  FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
  createBfcacheSegmentStateKeyMap,
  createInitialBfcacheIdMap,
  resolveServerActionRequestState,
  type AppNavigationPayloadOrigin,
  type AppRouterState,
  type HistoryTraversalIntent,
  type OperationLane,
} from "./app-browser-state.js";
import { AppBrowserHistoryController } from "./app-browser-history-controller.js";
import {
  DevRecoveryBoundary,
  GlobalErrorBoundary,
  RedirectBoundary,
} from "vinext/shims/error-boundary";
import DefaultGlobalError from "vinext/shims/default-global-error";
import { AppRouterContext } from "vinext/shims/internal/app-router-context";
import { BfcacheStateKeyMapContext, ElementsContext, Slot } from "vinext/shims/slot";
import type { RouteManifest } from "../routing/app-route-graph.js";
import {
  createDevOnCaughtError,
  createOnUncaughtError,
  createProdOnCaughtError,
  prodOnRecoverableError,
} from "./app-browser-error.js";
import {
  clearAppNavigationFailureTarget,
  installAppNavigationFailureListeners,
} from "../client/app-nav-failure-handler.js";
import {
  devOnCaughtError,
  dismissOverlay,
  installDevErrorOverlay,
  installViteHmrErrorHandler,
  reportInitialDevServerErrors,
} from "./dev-error-overlay.js";
import {
  createRscRequestHeaders,
  createRscRequestUrl,
  getVinextRscCompatibilityId,
  VINEXT_RSC_CONTENT_TYPE,
} from "./app-rsc-cache-busting.js";
import { VINEXT_PARAMS_HEADER } from "./headers.js";
import { removeStylesheetLinksCoveredByInlineCss } from "./app-inline-css-client.js";

type SearchParamInput = ConstructorParameters<typeof URLSearchParams>[0];
type AppBrowserNavigationSupport = typeof import("./app-browser-navigation-support.js");

type ServerActionResult = AppBrowserServerActionResult<AppWireElements>;

type MpaNavigationState = {
  href: string;
  historyUpdateMode: HistoryUpdateMode;
  kind: "mpa-navigation";
};

const CLIENT_RSC_COMPATIBILITY_ID = getVinextRscCompatibilityId();
let appBrowserNavigationSupport: AppBrowserNavigationSupport | null = null;
let appBrowserNavigationSupportPromise: Promise<AppBrowserNavigationSupport> | null = null;

function loadAppBrowserNavigationSupport(): Promise<AppBrowserNavigationSupport> {
  appBrowserNavigationSupportPromise ??= import("./app-browser-navigation-support.js").then(
    (support) => {
      appBrowserNavigationSupport = support;
      return support;
    },
  );
  return appBrowserNavigationSupportPromise;
}

function claimInitialAppRouterBootstrap(): boolean {
  if (window.__VINEXT_RSC_ROOT__ || window.__VINEXT_RSC_BOOTSTRAP_STATE__) {
    return false;
  }
  window.__VINEXT_RSC_BOOTSTRAP_STATE__ = "starting";
  return true;
}

function markInitialAppRouterBootstrapHydrated(): void {
  window.__VINEXT_RSC_BOOTSTRAP_STATE__ = "hydrated";
}

function getBrowserRouteManifest(): RouteManifest | null {
  return getNavigationRuntime()?.bootstrap.routeManifest ?? null;
}

function loadBrowserNavigationDependenciesIfNeeded(): Promise<unknown> | null {
  const loads: Promise<unknown>[] = [];
  if (getBrowserRouteManifest() === null) {
    loads.push(loadNavigationRuntimeRouteManifest());
  }
  if (!isClientNavigationPlannerModuleLoaded()) {
    loads.push(loadClientNavigationPlannerModule());
  }
  if (appBrowserNavigationSupport === null) {
    loads.push(loadAppBrowserNavigationSupport());
  }
  return loads.length === 0 ? null : Promise.all(loads);
}

const MAX_HISTORY_STATE_SNAPSHOTS = 50;
const historyController = new AppBrowserHistoryController({
  initialHistoryState: window.history.state,
  maxHistoryStateSnapshots: MAX_HISTORY_STATE_SNAPSHOTS,
  readHistoryState: () => window.history.state,
  readCurrentHref: () => window.location.href,
  pushHistoryState: (state, href) => pushHistoryStateWithoutNotify(state, "", href),
  replaceHistoryState: (state, href) => replaceHistoryStateWithoutNotify(state, "", href),
  readVisibleNavigationMetadata: () => {
    if (!hasBrowserRouterState()) return null;
    const routerState = getBrowserRouterState();
    return { bfcacheIds: routerState.bfcacheIds, previousNextUrl: routerState.previousNextUrl };
  },
});

const browserNavigationController = createAppBrowserNavigationController({
  basePath: __basePath,
  getRouteManifest: getBrowserRouteManifest,
  syncHistoryStatePreviousNextUrl: (previousNextUrl, bfcacheIds) =>
    historyController.syncCurrentHistoryStatePreviousNextUrl(previousNextUrl, bfcacheIds),
});
const discardedServerActionRefreshScheduler = createDiscardedServerActionRefreshScheduler({
  runRefresh() {
    clearClientNavigationCaches();
    void getNavigationRuntime()?.functions.navigate?.(
      window.location.href,
      0,
      "refresh",
      undefined,
      undefined,
      true,
    );
  },
});
const NavigationCommitSignal = browserNavigationController.NavigationCommitSignal;
const ACTION_HTTP_FALLBACK_ROBOTS_META_ATTR = "data-vinext-action-http-fallback";

function syncServerActionHttpFallbackHead(status: number | null): void {
  document.head
    .querySelectorAll(`meta[${ACTION_HTTP_FALLBACK_ROBOTS_META_ATTR}="robots"]`)
    .forEach((node) => node.remove());

  if (status !== 404) return;

  const robots = document.createElement("meta");
  robots.name = "robots";
  robots.content = "noindex";
  robots.setAttribute(ACTION_HTTP_FALLBACK_ROBOTS_META_ATTR, "robots");
  document.head.appendChild(robots);
}
const BfcacheIdMapContext = getBfcacheIdMapContext();

// Parses a URI-encoded JSON value carried in a response header (e.g.
// `X-Vinext-Params`). Returns `null` on missing or malformed input so callers
// can fall back to their own defaults. Silent by design — these headers are
// best-effort hydration data and a parse failure should not break navigation.
function parseEncodedJsonHeader<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(decodeURIComponent(value)) as T;
  } catch {
    return null;
  }
}

function isRouterStatePromise(
  value: AppRouterState | Promise<AppRouterState> | MpaNavigationState,
): value is Promise<AppRouterState> {
  return value instanceof Promise;
}

let latestClientParams: Record<string, string | string[]> = {};
// Sticky bit: stays true once BrowserRoot has committed at least once. Used by
// the HMR handler to distinguish "still hydrating" (wait) from "was up, then
// torn down by a render error" (full reload to recover).
let browserRouterStateHasEverCommitted = false;
const mpaNavigationScheduler = new AppBrowserMpaNavigationScheduler();
const unresolvedMpaNavigation = new Promise<never>(() => {});
const RSC_HMR_SETTLE_DELAY_MS = 150;
const DEFAULT_GLOBAL_ERROR_COMPONENT = DefaultGlobalError as React.ComponentType<{
  error: unknown;
  reset: () => void;
}>;
let latestRscHmrUpdateId = 0;

// Vite can notify the browser about an RSC HMR update before the dev server's
// request runner has swapped to the invalidated module graph. Give the
// invalidated graph a short settle window so HMR sees the same payload a
// direct refresh would see.
function waitForRscHmrSettle(delayMs = RSC_HMR_SETTLE_DELAY_MS): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, delayMs);
  });
}

function getBrowserRouterState(): AppRouterState {
  return browserNavigationController.getBrowserRouterState();
}

function hasBrowserRouterState(): boolean {
  return browserNavigationController.hasBrowserRouterState();
}

function waitForBrowserRouterStateReady(): Promise<void> {
  return browserNavigationController.waitForBrowserRouterStateReady();
}

function applyClientParams(params: Record<string, string | string[]>): void {
  latestClientParams = params;
  setClientParams(params);
}

function stageClientParams(params: Record<string, string | string[]>): void {
  // NB: latestClientParams diverges from ClientNavigationState.clientParams
  // between staging and commit. Server action snapshots capture the committed
  // browser router state at invocation time, so they do not read this mutable
  // module-level value after their async request boundary.
  latestClientParams = params;
  replaceClientParamsWithoutNotify(params);
}

function clearClientNavigationCaches(): void {
  invalidatePrefetchCache();
  appBrowserNavigationSupport?.clearAppBrowserNavigationState();
  historyController.invalidateRestorableClientState();
}

function createActionInitiationSnapshot() {
  const routerState = getBrowserRouterState();
  return createServerActionInitiationSnapshot({
    href: window.location.href,
    navigationId: browserNavigationController.getActiveNavigationId(),
    routerState,
  });
}

type ActionInitiationSnapshot = ReturnType<typeof createActionInitiationSnapshot>;

function createNavigationCommitEffect(options: {
  bfcacheIds: Readonly<Record<string, string>>;
  href: string;
  historyUpdateMode: HistoryUpdateMode | undefined;
  navId: number;
  params: Record<string, string | string[]>;
  previousNextUrl: string | null;
  targetHistoryIndex?: number | null;
}): () => void {
  const {
    bfcacheIds,
    href,
    historyUpdateMode,
    navId,
    params,
    previousNextUrl,
    targetHistoryIndex,
  } = options;

  return () => {
    // Only update URL if this is still the active navigation.
    // A newer navigation would have superseded this navigation id.
    if (!browserNavigationController.isCurrentNavigation(navId)) {
      // This transition was superseded before commit; balance the active
      // snapshot counter without clearing pendingPathname ownership.
      commitClientNavigationState(undefined, { releaseSnapshot: true });
      return;
    }

    historyController.commitNavigationHistory({
      bfcacheIds,
      href,
      historyUpdateMode,
      previousNextUrl,
      stageClientParams: () => stageClientParams(params),
      targetHistoryIndex,
    });

    // URL has been updated; the recovery hard-nav target is no longer needed.
    clearAppNavigationFailureTarget(href);
    commitClientNavigationState(navId);
  };
}

async function renderNavigationPayload(
  payload: Promise<AppElements>,
  navigationSnapshot: ClientNavigationRenderSnapshot,
  targetHref: string,
  navId: number,
  historyUpdateMode: HistoryUpdateMode | undefined,
  params: Record<string, string | string[]>,
  previousNextUrl: string | null,
  pendingRouterState: PendingBrowserRouterState | null,
  payloadOrigin: AppNavigationPayloadOrigin,
  actionType: "navigate" | "replace" | "traverse" = "navigate",
  operationLane: OperationLane = "navigation",
  traversalIntent: HistoryTraversalIntent | null = null,
  scrollIntent: AppRouterScrollIntent | null | undefined = null,
  restoredBfcacheIds: Readonly<Record<string, string>> | null = null,
  reuseCurrentBfcacheIds: boolean = true,
  visibleCommitMode: NavigationRuntimeVisibleCommitMode = "transition",
): Promise<NavigationPayloadOutcome> {
  syncServerActionHttpFallbackHead(null);
  return browserNavigationController.renderNavigationPayload({
    actionType,
    createNavigationCommitEffect,
    historyUpdateMode,
    navigationSnapshot,
    nextElements: payload,
    operationLane,
    payloadOrigin,
    params,
    pendingRouterState,
    previousNextUrl,
    scrollIntent,
    restoredBfcacheIds,
    reuseCurrentBfcacheIds,
    targetHistoryIndex: traversalIntent === null ? undefined : traversalIntent.targetHistoryIndex,
    targetHref,
    navId,
    visibleCommitMode,
  });
}

async function commitSameUrlNavigatePayload(
  nextElements: Promise<AppElements>,
  actionInitiation: ActionInitiationSnapshot,
  returnValue?: ServerActionResult["returnValue"],
  revalidation: ServerActionRevalidationKind = "none",
): Promise<unknown> {
  const navigationSnapshot = createClientNavigationRenderSnapshot(
    actionInitiation.href,
    actionInitiation.routerState.navigationSnapshot.params,
  );
  return browserNavigationController.commitSameUrlNavigatePayload(
    nextElements,
    navigationSnapshot,
    returnValue,
    actionInitiation.routerState,
    {
      onDiscardedRevalidation() {
        discardedServerActionRefreshScheduler.schedule();
      },
      revalidation,
      startedNavigationId: actionInitiation.navigationId,
      targetHref: actionInitiation.href,
    },
  );
}

// Dev-only callback invoked when DevRecoveryBoundary catches. The replaced
// subtree means NavigationCommitSignal's useLayoutEffect never fires, so the
// URL update for the in-flight navigation would otherwise be lost. Force-drain
// the queued pre-paint effect for this renderId so the URL still moves to the
// navigation target, the dev overlay shows which URL is broken, and HMR's
// rsc:update fetches the right payload after the bug is fixed.
function handleDevRecoveryBoundaryCatch(resetKey: number): void {
  // React's onCaughtError option already routes the error to the dev overlay.
  // Our job here is purely to drive the URL update for the in-flight
  // navigation that this failed render belonged to.
  browserNavigationController.drainPrePaintEffects(resetKey);
}

function isMpaNavigationState(
  value: AppRouterState | Promise<AppRouterState> | MpaNavigationState,
): value is MpaNavigationState {
  return (
    value !== null &&
    typeof value === "object" &&
    "kind" in value &&
    value.kind === "mpa-navigation"
  );
}

function performMpaNavigation(href: string, historyUpdateMode: HistoryUpdateMode): void {
  // Match Next's MPA path by suspending forever, but delay the actual location
  // mutation just enough for the old tree to commit the pending transition
  // signal before unload.
  mpaNavigationScheduler.navigate(window, href, historyUpdateMode);
}

function AppRouterRedirectBridge({ children }: { children?: React.ReactNode }) {
  const router = useRouter();

  useEffect(() => {
    const handleUnhandledRedirect = (event: ErrorEvent | PromiseRejectionEvent): void => {
      const error = "reason" in event ? event.reason : event.error;
      if (!isRedirectError(error)) return;

      const result = decodeRedirectError(error.digest);
      if (!result) return;

      event.preventDefault();
      startTransition(() => {
        if (result.type === "push") {
          router.push(result.url);
        } else {
          router.replace(result.url);
        }
      });
    };

    window.addEventListener("error", handleUnhandledRedirect);
    window.addEventListener("unhandledrejection", handleUnhandledRedirect);

    return () => {
      window.removeEventListener("error", handleUnhandledRedirect);
      window.removeEventListener("unhandledrejection", handleUnhandledRedirect);
    };
  }, [router]);

  return children ?? null;
}

function decodeAppElementsPromise(payload: Promise<AppWireElements>): Promise<AppElements> {
  // Wrap in Promise.resolve() because createFromReadableStream() returns a
  // React Flight thenable whose .then() returns undefined (not a new Promise).
  // Without the wrap, chaining .then() produces undefined → use() crashes.
  return Promise.resolve(payload).then((elements) => AppElementsWire.decode(elements));
}

function BrowserRoot({
  initialElements,
  initialNavigationSnapshot,
}: {
  initialElements: Promise<AppElements>;
  initialNavigationSnapshot: ClientNavigationRenderSnapshot;
}) {
  const resolvedElements = use(initialElements);
  const initialMetadata = AppElementsWire.readMetadata(resolvedElements);
  const [treeStateValue, setTreeStateValue] = useState<
    AppRouterState | Promise<AppRouterState> | MpaNavigationState
  >(() => ({
    activeOperation: null,
    // Intentional Next.js parity: a hard reload starts a new browser
    // document without the prior in-memory router state. Hydrate
    // the new document on the zero sentinel and rely on the document-scoped
    // bfcache version gate to reject stale ids persisted by previous
    // documents.
    bfcacheIds: createInitialBfcacheIdMap(resolvedElements),
    elements: resolvedElements,
    interception: initialMetadata.interception,
    interceptionContext: initialMetadata.interceptionContext,
    layoutIds: initialMetadata.layoutIds,
    layoutFlags: initialMetadata.layoutFlags,
    navigationSnapshot: initialNavigationSnapshot,
    previousNextUrl: null,
    renderId: 0,
    rootLayoutTreePath: initialMetadata.rootLayoutTreePath,
    routeId: initialMetadata.routeId,
    slotBindings: initialMetadata.slotBindings,
    visibleCommitVersion: 0,
  }));
  if (isMpaNavigationState(treeStateValue)) {
    performMpaNavigation(treeStateValue.href, treeStateValue.historyUpdateMode);
    throw unresolvedMpaNavigation;
  }
  const treeState = isRouterStatePromise(treeStateValue) ? use(treeStateValue) : treeStateValue;
  // Keep the latest router state in a ref so external callers (navigate(),
  // server actions, HMR) always read the current state. Safe: those readers
  // run from events/effects, never from React render itself.
  // Note: stateRef.current is written during render, not in an effect, to
  // avoid a stale-read window between commit and layout effects. This mirrors
  // the same render-phase ref update pattern used by Next.js's own router.
  const stateRef = useRef(treeState);
  stateRef.current = treeState;

  // Publish the stable ref object and dispatch during layout commit. This keeps
  // the module-level escape hatches aligned with React's committed tree without
  // performing module writes during render. The navigation runtime is registered
  // after hydrateRoot() returns; by then this layout effect has already run for
  // the hydration commit, so getBrowserRouterState() never observes a null ref.
  useLayoutEffect(() => {
    const setAppRouterStateValue = (value: AppRouterState | Promise<AppRouterState>) => {
      setTreeStateValue(value);
    };
    const detach = browserNavigationController.attachBrowserRouterState(
      setAppRouterStateValue,
      stateRef,
    );
    registerNavigationRuntimeFunctions({
      navigateExternal: (href, historyUpdateMode) => {
        setTreeStateValue({
          href,
          historyUpdateMode,
          kind: "mpa-navigation",
        });
        return new Promise<void>(() => {});
      },
    });
    browserRouterStateHasEverCommitted = true;
    return () => {
      registerNavigationRuntimeFunctions({ navigateExternal: undefined });
      detach();
      setMountedSlotsHeader(null);
    };
  }, [setTreeStateValue]);

  // Next.js publishes its deploy-test hydration marker from a passive effect in
  // app-index's Root wrapper. Keep the same timing: route client effects have
  // committed, so callers that mutate the document after __NEXT_HYDRATED_CB
  // cannot race the initial hydration pass.
  useEffect(() => {
    const hydratedAt = performance.now();
    window.__VINEXT_HYDRATED_AT = hydratedAt;
    window.__NEXT_HYDRATED = true;
    window.__NEXT_HYDRATED_AT = hydratedAt;
    window.__NEXT_HYDRATED_CB?.();
  }, []);

  // This effect snapshots treeState against the controller's current traversal
  // index but only depends on [treeState]. The ordering works because the
  // traversal-index commit runs inside the navigation commit effect (before
  // setTreeStateValue fires), so the index is already current when this layout
  // effect runs for the new treeState. If the commit ordering ever changes, the
  // snapshot index may not match the traversed history entry, causing
  // resolveRestore to read the wrong index on back.
  useLayoutEffect(() => {
    historyController.rememberHistoryStateSnapshot(treeState);
  }, [treeState]);

  useEffect(() => {
    setWindowNextInternalSourcePage(AppElementsWire.readMetadata(treeState.elements).sourcePage);
  }, [treeState.elements]);

  useLayoutEffect(() => {
    setMountedSlotsHeader(getMountedSlotIdsHeader(stateRef.current.elements));
    removeStylesheetLinksCoveredByInlineCss();
    getNavigationRuntime()?.functions.pingVisibleLinks?.();
  }, [treeState.elements]);

  useLayoutEffect(() => {
    if (treeState.renderId !== 0) {
      return;
    }

    historyController.writeHydratedHistoryMetadata({
      bfcacheIds: treeState.bfcacheIds,
      previousNextUrl: treeState.previousNextUrl,
    });
  }, [treeState.bfcacheIds, treeState.previousNextUrl, treeState.renderId]);

  const routeTree = createElement(
    RedirectBoundary,
    null,
    createElement(
      NavigationCommitSignal,
      { renderId: treeState.renderId },
      createElement(
        ElementsContext.Provider,
        { value: treeState.elements },
        createElement(Slot, { id: treeState.routeId }),
      ),
    ),
  );
  const bfcacheStateKeys = useMemo(
    () =>
      createBfcacheSegmentStateKeyMap({
        elements: treeState.elements,
        pathname: treeState.navigationSnapshot.pathname,
      }),
    [treeState.elements, treeState.navigationSnapshot.pathname],
  );
  const stateKeyTree = createElement(
    BfcacheStateKeyMapContext.Provider,
    { value: bfcacheStateKeys },
    routeTree,
  );
  const bfcacheTree = BfcacheIdMapContext
    ? createElement(BfcacheIdMapContext.Provider, { value: treeState.bfcacheIds }, stateKeyTree)
    : stateKeyTree;
  const redirectedTree = createElement(AppRouterRedirectBridge, null, bfcacheTree);
  const innerTree = AppRouterContext
    ? createElement(AppRouterContext.Provider, { value: appRouterInstance }, redirectedTree)
    : redirectedTree;

  // In dev, wrap the route tree in a top-level recovery boundary. A render
  // error (e.g. a slot's RSC reference rejects) is caught here instead of
  // tearing down BrowserRoot, so HMR can dispatch the next payload —
  // identified by an incremented renderId, which doubles as the boundary's
  // reset key — without a full page reload. The dev overlay (a separate
  // React root) shows the error itself.
  //
  // onCatch drains the pending pre-paint effect for the failed render so
  // the URL update bound to that navigation still runs. Without this, a
  // soft-nav whose target throws would leave the browser on the previous
  // URL, hiding which route is broken and mis-targeting the next HMR
  // payload (which fetches RSC for window.location.pathname).
  //
  // This file is .ts, not .tsx — children are passed positionally to satisfy
  // both the createElement overload and eslint's no-children-prop rule.
  const committedTree = import.meta.env.DEV
    ? createElement(
        DevRecoveryBoundary,
        {
          isImplicitRootErrorBoundary: true,
          resetKey: treeState.renderId,
          onCatch: handleDevRecoveryBoundaryCatch,
        },
        innerTree,
      )
    : innerTree;

  const scrollScopedTree = createElement(
    AppRouterScrollCommitProvider,
    { commitId: treeState.renderId },
    committedTree,
  );
  const rootErrorTree = createElement(GlobalErrorBoundary, {
    fallback: DEFAULT_GLOBAL_ERROR_COMPONENT,
    // oxlint-disable-next-line react/no-children-prop -- This generated browser entry is TypeScript, not TSX.
    children: scrollScopedTree,
  });

  const ClientNavigationRenderContext = getClientNavigationRenderContext();
  if (!ClientNavigationRenderContext) {
    return rootErrorTree;
  }

  return createElement(
    ClientNavigationRenderContext.Provider,
    { value: treeState.navigationSnapshot },
    rootErrorTree,
  );
}

function restoreHydrationNavigationContext(
  pathname: string,
  searchParams: SearchParamInput,
  params: Record<string, string | string[]>,
): void {
  setNavigationContext({
    pathname,
    searchParams: new URLSearchParams(searchParams),
    params,
  });
}

// Set on pagehide so the RSC navigation catch block can distinguish expected
// fetch aborts (triggered by the unload itself) from real errors worth logging.
let isPageUnloading = false;

const RSC_RELOAD_KEY = "__vinext_rsc_initial_reload__";

// sessionStorage can throw SecurityError in strict-mode iframes, storage-
// disabled browsers, and some Safari private-browsing configurations. Wrap
// every access so a recovery path for one error does not crash hydration.
function readReloadFlag(): string | null {
  try {
    return sessionStorage.getItem(RSC_RELOAD_KEY);
  } catch {
    return null;
  }
}
function writeReloadFlag(path: string): void {
  try {
    sessionStorage.setItem(RSC_RELOAD_KEY, path);
  } catch {}
}
function clearReloadFlag(): void {
  try {
    sessionStorage.removeItem(RSC_RELOAD_KEY);
  } catch {}
}

// A non-ok or wrong-content-type RSC response during initial hydration means
// the server cannot deliver a valid RSC payload for this URL. Parsing the
// response as RSC causes an opaque parse failure. On the first attempt,
// reload once so the server has a chance to render the correct error page
// as HTML. On the second attempt (detected via the sessionStorage flag), the
// endpoint is persistently broken. Returns null so main() aborts the
// hydration bootstrap without registering RSC navigation globals —
// including during the brief window between reload() firing and the page
// actually unloading — so external probes never see a half-hydrated page.
function recoverFromBadInitialRscResponse(reason: string): null {
  const currentPath = window.location.pathname + window.location.search;
  if (readReloadFlag() === currentPath) {
    clearReloadFlag();
    console.error(
      `[vinext] Initial RSC fetch ${reason} after reload; aborting hydration. ` +
        "Server-rendered HTML remains visible; client components will not hydrate.",
    );
    return null;
  }
  writeReloadFlag(currentPath);
  // Verify the write persisted. In storage-denied environments (strict-mode
  // iframes, locked-down enterprise policies), every getItem returns null and
  // every setItem silently no-ops, so the reload-loop guard cannot survive
  // the reload — the page would loop forever. Abort instead so the user at
  // least sees the server-rendered HTML.
  if (readReloadFlag() !== currentPath) {
    console.error(
      `[vinext] Initial RSC fetch ${reason}; sessionStorage unavailable so the ` +
        "reload-loop guard cannot persist — aborting hydration. " +
        "Server-rendered HTML remains visible; client components will not hydrate.",
    );
    return null;
  }
  // One-shot diagnostic so a production reload is traceable. Only fires once
  // per broken path thanks to the sessionStorage flag above; not noisy.
  console.warn(
    `[vinext] Initial RSC fetch ${reason}; reloading once to let the server render the HTML error page`,
  );
  window.location.reload();
  return null;
}

async function readInitialRscStream(): Promise<ReadableStream<Uint8Array> | null> {
  const vinext = getVinextBrowserGlobal();
  const runtimeRsc = getNavigationRuntime()?.bootstrap.rsc;

  if (runtimeRsc || vinext.__VINEXT_RSC_CHUNKS__ || vinext.__VINEXT_RSC_DONE__) {
    // Reaching the embedded-RSC branch means the server successfully rendered
    // the page — any prior reload flag for this path is stale and must be
    // cleared so a future failure gets its own fresh recovery attempt.
    clearReloadFlag();
    clearHardNavigationLoopGuard();

    if (runtimeRsc) {
      applyRuntimeRscBootstrap(runtimeRsc);
      if (runtimeRsc.done) {
        registerNavigationRuntimeBootstrap({ rsc: undefined });
        return chunksToReadableStream(runtimeRsc.rsc);
      }
      // The progressive stream must capture this bootstrap object before any
      // cleanup clears it from the runtime.
      return createProgressiveRscStream();
    }

    const params = vinext.__VINEXT_RSC_PARAMS__ ?? {};
    if (vinext.__VINEXT_RSC_PARAMS__) {
      applyClientParams(vinext.__VINEXT_RSC_PARAMS__);
    }
    if (vinext.__VINEXT_RSC_NAV__) {
      restoreHydrationNavigationContext(
        vinext.__VINEXT_RSC_NAV__.pathname,
        vinext.__VINEXT_RSC_NAV__.searchParams,
        params,
      );
    }

    return createProgressiveRscStream();
  }

  const rscHeaders = createRscRequestHeaders();
  const rscResponse = await fetch(
    await createRscRequestUrl(window.location.pathname + window.location.search, rscHeaders),
    { credentials: "include", headers: rscHeaders },
  );

  if (!rscResponse.ok) {
    return recoverFromBadInitialRscResponse(`returned ${rscResponse.status}`);
  }
  // Guard against proxies/CDNs that return 200 with a rewritten Content-Type
  // (e.g. text/html instead of text/x-component). Such responses cannot be
  // parsed as RSC and would throw the same opaque parse error this fallback
  // exists to prevent.
  const contentType = rscResponse.headers.get("content-type") ?? "";
  if (!contentType.startsWith(VINEXT_RSC_CONTENT_TYPE)) {
    return recoverFromBadInitialRscResponse(
      `returned non-RSC content-type "${contentType || "(missing)"}"`,
    );
  }
  // Missing body (e.g. 204 No Content, or an edge worker that returned ok
  // headers without piping the stream) fails the same way downstream.
  // Matches Next.js' `!res.body` branch in fetch-server-response.ts.
  if (!rscResponse.body) {
    return recoverFromBadInitialRscResponse("returned empty body");
  }
  // Successful RSC response clears the guard so a subsequent reload of the
  // same path after a transient failure still gets one recovery attempt.
  clearReloadFlag();
  clearHardNavigationLoopGuard();

  // Ignore malformed param headers and continue with hydration. The original
  // try/catch also swallowed errors from applyClientParams; preserve that.
  const parsedParams = parseEncodedJsonHeader<Record<string, string | string[]>>(
    rscResponse.headers.get(VINEXT_PARAMS_HEADER),
  );
  const params: Record<string, string | string[]> = parsedParams ?? {};
  if (parsedParams) {
    try {
      applyClientParams(parsedParams);
    } catch {
      // Ignore — matches the previous combined try/catch behavior.
    }
  }

  restoreHydrationNavigationContext(window.location.pathname, window.location.search, params);

  return rscResponse.body;
}

function applyRuntimeRscBootstrap(rsc: NavigationRuntimeRscBootstrap): void {
  const params = rsc.params ?? {};
  if (rsc.params) {
    applyClientParams(rsc.params);
  }
  if (rsc.nav) {
    restoreHydrationNavigationContext(rsc.nav.pathname, rsc.nav.searchParams, params);
  }
}

function registerServerActionCallback(): void {
  setServerCallback((id, args) => {
    const releaseCacheInvalidationGuard = historyController.beginCacheInvalidationGuard();
    return import("./app-browser-server-action-client.js")
      .then(({ invokeClientServerAction }) =>
        invokeClientServerAction(id, args, {
          basePath: __basePath,
          clearClientNavigationCaches,
          clientRscCompatibilityId: CLIENT_RSC_COMPATIBILITY_ID,
          commitSameUrlNavigatePayload,
          createActionInitiationSnapshot,
          getNavigationPlanner: () => getClientNavigationPlannerModule().navigationPlanner,
          loadNavigationDependencies: loadBrowserNavigationDependenciesIfNeeded,
          performHardNavigation: (url, historyMode) =>
            browserNavigationController.performHardNavigation(url, historyMode),
          renderRedirectPayload(elements, target, actionInitiation) {
            const hashIdx = target.href.indexOf("#");
            const hash = hashIdx !== -1 ? target.href.slice(hashIdx) : "";
            const actionScrollIntent = beginAppRouterScrollIntent(hash || null);
            if (target.type === "push") saveScrollPosition();
            void renderNavigationPayload(
              Promise.resolve(elements),
              createClientNavigationRenderSnapshot(
                target.href,
                actionInitiation.routerState.navigationSnapshot.params,
              ),
              target.href,
              actionInitiation.navigationId,
              target.type === "push" ? "push" : "replace",
              {},
              null,
              null,
              FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
              target.type === "push" ? "navigate" : "replace",
              "server-action",
              null,
              actionScrollIntent,
            ).catch(() => {
              browserNavigationController.performHardNavigation(target.href);
            });
          },
          resolveServerActionRequestHeaders(actionId, actionInitiation) {
            return resolveServerActionRequestState({
              actionId,
              basePath: __basePath,
              elements: actionInitiation.routerState.elements,
              previousNextUrl: actionInitiation.routerState.previousNextUrl,
            }).headers;
          },
          syncCurrentHistoryState: (previousNextUrl, bfcacheIds) =>
            historyController.syncCurrentHistoryStatePreviousNextUrl(previousNextUrl, bfcacheIds),
          syncServerActionHttpFallbackHead,
        }),
      )
      .finally(releaseCacheInvalidationGuard);
  });
}

async function main(): Promise<void> {
  if (!claimInitialAppRouterBootstrap()) return;

  registerServerActionCallback();
  installAppNavigationFailureListeners();

  if (import.meta.env.DEV) {
    installDevErrorOverlay();
    installViteHmrErrorHandler(import.meta.hot);
    reportInitialDevServerErrors();
  }

  const rscStream = await readInitialRscStream();
  // null signals that readInitialRscStream aborted hydration — either because
  // a reload is in flight (first-attempt recovery) or the endpoint is
  // persistently broken (post-reload). Bootstrap is a separate synchronous
  // helper so the null-branch structurally cannot reach any RSC bootstrap
  // global assignment, even if a future refactor interposes async work here.
  // The recovery path reloads the document, which resets the "starting" claim;
  // this module instance is intentionally not eligible to retry bootstrap.
  if (rscStream === null) return;
  bootstrapHydration(rscStream);
}

function bootstrapHydration(rscStream: ReadableStream<Uint8Array>): void {
  const root = decodeAppElementsPromise(createFromReadableStream<AppWireElements>(rscStream));
  const initialNavigationSnapshot = createClientNavigationRenderSnapshot(
    window.location.href,
    latestClientParams,
  );
  historyController.writeBootstrapHistoryMetadata();

  const onUncaughtError = createOnUncaughtError();
  const formState = consumeInitialFormState(getVinextBrowserGlobal());
  const hydrateRootOptions = import.meta.env.DEV
    ? createVinextHydrateRootOptions({
        formState,
        onCaughtError: createDevOnCaughtError(devOnCaughtError, onUncaughtError),
        onUncaughtError,
      })
    : createVinextHydrateRootOptions({
        formState,
        onCaughtError: createProdOnCaughtError(onUncaughtError),
        onRecoverableError: prodOnRecoverableError,
        onUncaughtError,
      });
  const children = createElement(BrowserRoot, {
    initialElements: root,
    initialNavigationSnapshot,
  });
  const errorShellStyles = document.querySelectorAll("style[data-vinext-error-shell-style]");
  if (document.documentElement.id === "__next_error__") {
    // Next.js client/app-index.tsx uses the document id alone to select CSR
    // after any failed App Router server render. The style marker only scopes
    // cleanup to vinext's shell-recovery placeholder styles.
    // There is no server-rendered form to hydrate in this client-render path;
    // reuse only the shared root error callbacks and related root options.
    const { formState: _inertFormState, ...createRootOptions } = hydrateRootOptions;
    for (const style of errorShellStyles) {
      style.remove();
    }
    startTransition(() => {
      const clientRoot = createRoot(document, createRootOptions);
      clientRoot.render(children);
      window.__VINEXT_RSC_ROOT__ = clientRoot;
    });
  } else {
    window.__VINEXT_RSC_ROOT__ = hydrateRootInTransition({
      children,
      container: document,
      hydrateRoot,
      options: hydrateRootOptions,
      startTransition,
    });
  }
  markInitialAppRouterBootstrapHydrated();

  const navigateRsc: NavigationRuntimeNavigate = async (...args) => {
    const executorLoad = import("./app-browser-navigation-executor.js");
    const navigationDependenciesLoad = loadBrowserNavigationDependenciesIfNeeded();
    if (navigationDependenciesLoad !== null) await navigationDependenciesLoad;
    const { executeClientNavigation } = await executorLoad;
    return executeClientNavigation(
      {
        basePath: __basePath,
        browserNavigationController,
        clientRscCompatibilityId: CLIENT_RSC_COMPATIBILITY_ID,
        createFromFetch,
        decodeAppElementsPromise,
        discardedServerActionRefreshScheduler,
        getBrowserRouteManifest,
        historyController,
        isPageUnloading: () => isPageUnloading,
        navigationPlanner: getClientNavigationPlannerModule().navigationPlanner,
        renderNavigationPayload,
      },
      ...args,
    );
  };

  // Exposed through one typed runtime seam so next/navigation, Link, Form, and
  // the browser entry share a single App Router capability contract.
  registerNavigationRuntimeFunctions({
    clearNavigationCaches: clearClientNavigationCaches,
    commitHashNavigation: (href, historyUpdateMode, scroll) =>
      historyController.commitHashOnlyNavigation(href, historyUpdateMode, scroll),
    navigate: navigateRsc,
  });

  window.addEventListener("popstate", (event) => {
    // History mutation can run in the same task as popstate observers. Keep the
    // traversal index synchronous even though restoration is loaded lazily.
    historyController.commitTraversalIndexFromHistoryState(event.state);
    void import("./app-browser-popstate-client.js")
      .then(({ handleAppBrowserPopstate }) =>
        handleAppBrowserPopstate(event, {
          basePath: __basePath,
          browserNavigationController,
          historyController,
          loadNavigationDependencies: loadBrowserNavigationDependenciesIfNeeded,
          stageClientParams,
        }),
      )
      .catch((error: unknown) => {
        console.error("[vinext] Failed to load App Router navigation metadata:", error);
        window.location.reload();
      });
  });

  if (import.meta.hot) {
    const applyRscHmrUpdate = async (updateId: number): Promise<void> => {
      if (updateId !== latestRscHmrUpdateId) return;

      // Root layout errors can leave the browser on a document-level error
      // shell. A normal RSC tree replacement can't reliably reconstruct the
      // original document from there, so let the next HMR update reload the
      // current URL. If the edit fixed the error the page comes back clean; if
      // not, initial dev server errors re-populate the overlay.
      //
      // Reloading is safe for any default-error document because the dev
      // server will render the current state of the source after the edit.
      if (document.documentElement.id === "__next_error__") {
        window.location.reload();
        return;
      }

      // If BrowserRoot has been mounted before but isn't now, a render
      // error tore down the tree (e.g. a server route threw). HMR can't
      // dispatch into a missing setter, and waitForBrowserRouterStateReady
      // would block forever — the tree won't remount until the page reloads.
      // Trigger that reload so the user's fix actually lands without a
      // manual refresh. Cleared after a successful mount, so this only
      // fires once per teardown.
      if (
        browserRouterStateHasEverCommitted &&
        !browserNavigationController.hasBrowserRouterState()
      ) {
        window.location.reload();
        return;
      }
      // HMR can also fire before BrowserRoot's layout effect publishes
      // the browser router state (e.g. saving a file while the initial RSC
      // stream is still suspended). Wait for readiness, then re-check the
      // mounted state — readiness can race with cleanup, which nulls it again.
      // Skip silently when the tree is not currently mounted; the next
      // HMR push or full reload will reconcile.
      await waitForBrowserRouterStateReady();
      if (updateId !== latestRscHmrUpdateId) return;
      if (!browserNavigationController.hasBrowserRouterState()) {
        return;
      }
      const navigationDependenciesLoad = loadBrowserNavigationDependenciesIfNeeded();
      if (navigationDependenciesLoad !== null) await navigationDependenciesLoad;
      clearClientNavigationCaches();
      const navigationSnapshot = createClientNavigationRenderSnapshot(
        window.location.href,
        latestClientParams,
      );
      // Clear stale errors from the dev overlay before dispatching the
      // fresh tree. If the new tree renders cleanly, the overlay stays
      // empty; if it throws again, devOnCaughtError/devOnUncaughtError
      // re-populates it. Without this, an old "DropZone is not defined"
      // error would linger after the developer fixed the bug.
      dismissOverlay();
      // Interception context on HMR re-renders is intentionally deferred:
      // preserving intercepted modal state across HMR reloads is out of scope
      // for the previousNextUrl mechanism.
      const hmrHeaders = createRscRequestHeaders();
      await browserNavigationController.hmrReplaceTree(
        decodeAppElementsPromise(
          createFromFetch<AppWireElements>(
            fetch(
              await createRscRequestUrl(
                window.location.pathname + window.location.search,
                hmrHeaders,
              ),
              { headers: hmrHeaders },
            ),
          ),
        ),
        navigationSnapshot,
      );
    };

    const handleRscUpdate = async (updateId: number): Promise<void> => {
      try {
        await waitForRscHmrSettle();
        await applyRscHmrUpdate(updateId);
      } catch (error) {
        console.error("[vinext] RSC HMR error:", error);
      }
    };

    import.meta.hot.on("rsc:update", () => {
      const updateId = ++latestRscHmrUpdateId;
      void handleRscUpdate(updateId);
    });
  }
}

if (typeof document !== "undefined") {
  // Install `window.next` as early as possible so any client component that
  // synchronously dereferences it during hydration (or any third-party
  // library script tag that loads before the React tree mounts) sees the
  // expected shape. Mirrors Next.js's app-bootstrap.ts (line 13) which sets
  // `window.next = { version, appDir: true }` before the React runtime
  // initializes, and `app-router-instance.ts` (line 510) which assigns
  // `router: publicAppRouterInstance` at module load.
  installWindowNext({ appDir: true, router: appRouterInstance });

  window.addEventListener("pagehide", () => {
    isPageUnloading = true;
  });
  // Reset on pageshow so a bfcache-restored document does not resume with
  // the flag stuck at true, which would silently swallow every subsequent
  // RSC navigation error for the lifetime of that tab. Matches Next.js'
  // fetch-server-response.ts handler pair.
  window.addEventListener("pageshow", (event) => {
    isPageUnloading = false;
    if (event.persisted) {
      mpaNavigationScheduler.reset();
    }
  });
  void main();
}
