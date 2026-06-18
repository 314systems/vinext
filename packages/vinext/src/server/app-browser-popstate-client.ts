import { flushSync } from "react-dom";
import { commitClientNavigationState, createSnapshotPathAndSearch } from "vinext/shims/navigation";
import { retryScrollTo, scrollToHashTargetOnNextFrame } from "vinext/shims/hash-scroll";
import { notifyAppRouterTransitionStart } from "../client/instrumentation-client-state.js";
import { getNavigationRuntime } from "../client/navigation-runtime.js";
import {
  createBasePathStrippedPathAndSearch,
  type createAppBrowserNavigationController,
} from "./app-browser-navigation-controller.js";
import type { AppBrowserHistoryController } from "./app-browser-history-controller.js";
import {
  createPopstateRestoreHandler,
  restoreSynchronousPopstateScrollPosition,
} from "./app-browser-popstate.js";

type BrowserNavigationController = ReturnType<typeof createAppBrowserNavigationController>;

export type AppBrowserPopstateClientDeps = {
  basePath: string;
  browserNavigationController: BrowserNavigationController;
  historyController: AppBrowserHistoryController;
  loadNavigationDependencies(): Promise<unknown> | null;
  stageClientParams(params: Record<string, string | string[]>): void;
};

let synchronousPopstateScrollRestoreNavigationId: number | null = null;

function restorePopstateScrollPosition(
  state: unknown,
  options?: {
    shouldContinue?: () => boolean;
  },
): void {
  const shouldContinue = options?.shouldContinue ?? (() => true);
  if (!shouldContinue()) return;

  if (!(state && typeof state === "object" && "__vinext_scrollY" in state)) {
    if (window.location.hash) {
      scrollToHashTargetOnNextFrame(window.location.hash);
    }
    return;
  }

  const y = Number(state.__vinext_scrollY);
  const x = "__vinext_scrollX" in state ? Number(state.__vinext_scrollX) : 0;

  retryScrollTo(x, y, { minFrames: 1, shouldContinue });
}

function restoreHistoryStateSnapshot(
  historyState: unknown,
  deps: AppBrowserPopstateClientDeps,
): boolean {
  const navId = deps.browserNavigationController.getActiveNavigationId();
  let restored = false;
  flushSync(() => {
    restored = deps.historyController.restoreHistorySnapshot({
      historyState,
      stageClientParams: (params) => deps.stageClientParams(params),
      approveVisibleRestore: ({ state, beforeCommit }) =>
        deps.browserNavigationController.restoreHistorySnapshotVisibleState({
          beforeCommit,
          navId,
          state,
          targetHref: window.location.href,
        }),
    });
  });
  if (!restored) return false;

  commitClientNavigationState();
  return true;
}

function isSameAppRoutePopstateTarget(href: string, deps: AppBrowserPopstateClientDeps): boolean {
  if (!deps.browserNavigationController.hasBrowserRouterState()) return false;

  const target = new URL(href, window.location.origin);
  const routerState = deps.browserNavigationController.getBrowserRouterState();

  return (
    createBasePathStrippedPathAndSearch(target, deps.basePath) ===
    createSnapshotPathAndSearch(routerState.navigationSnapshot)
  );
}

export async function handleAppBrowserPopstate(
  event: PopStateEvent,
  deps: AppBrowserPopstateClientDeps,
): Promise<void> {
  const navigationDependenciesLoad = deps.loadNavigationDependencies();
  if (navigationDependenciesLoad !== null) await navigationDependenciesLoad;

  const href = window.location.href;
  if (isSameAppRoutePopstateTarget(href, deps)) {
    notifyAppRouterTransitionStart(href, "traverse");
    restorePopstateScrollPosition(event.state);
    return;
  }

  const handlePopstate = createPopstateRestoreHandler({
    getActiveNavigationId: () => deps.browserNavigationController.getActiveNavigationId(),
    getPendingNavigation: () => window.__VINEXT_RSC_PENDING__,
    getNavigate: () => getNavigationRuntime()?.functions.navigate,
    isCurrentNavigation: (navId) => deps.browserNavigationController.isCurrentNavigation(navId),
    notifyAppRouterTransitionStart: (targetHref) => {
      notifyAppRouterTransitionStart(targetHref, "traverse");
    },
    restorePopstateScrollPosition,
    setPendingNavigation: (pendingNavigation) => {
      window.__VINEXT_RSC_PENDING__ = pendingNavigation;
    },
    shouldSkipScrollRestore: (navId) => synchronousPopstateScrollRestoreNavigationId === navId,
  });
  handlePopstate(event);

  if (restoreHistoryStateSnapshot(event.state, deps)) {
    restoreSynchronousPopstateScrollPosition(
      {
        getActiveNavigationId: () => deps.browserNavigationController.getActiveNavigationId(),
        isCurrentNavigation: (navId) => deps.browserNavigationController.isCurrentNavigation(navId),
        markScrollRestoreConsumed: (navId) => {
          synchronousPopstateScrollRestoreNavigationId = navId;
        },
        restorePopstateScrollPosition,
      },
      event.state,
    );
  }
}
