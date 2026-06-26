import {
  readHistoryStateTraversalIndex,
  type HistoryTraversalIntent,
} from "./app-browser-state.js";
import type { NavigationRuntimeNavigate } from "../client/navigation-runtime.js";

type RestoreScrollPosition = (
  state: unknown,
  options?: {
    shouldContinue?: () => boolean;
  },
) => void;

type BrowserPopstateRestoreDeps = {
  getActiveNavigationId: () => number;
  getPendingNavigation: () => Promise<void> | null | undefined;
  getNavigate: () => NavigationRuntimeNavigate | undefined;
  isCurrentNavigation: (navId: number) => boolean;
  notifyAppRouterTransitionStart: (href: string) => void;
  restorePopstateScrollPosition: RestoreScrollPosition;
  settleRetainedHistoryNavigation?: (pendingNavigation: Promise<void>) => void;
  setPendingNavigation: (pendingNavigation: Promise<void> | null) => void;
  shouldSkipScrollRestore: (navId: number) => boolean;
  shouldSuppressTransitionStart?: () => boolean;
  tryRestoreHistorySnapshot?: (state: unknown) => boolean;
};

type SynchronousPopstateScrollRestoreDeps = {
  getActiveNavigationId: () => number;
  isCurrentNavigation: (navId: number) => boolean;
  markScrollRestoreConsumed: (navId: number) => void;
  restorePopstateScrollPosition: RestoreScrollPosition;
};

function hasSavedScrollPosition(state: unknown): boolean {
  return Boolean(state && typeof state === "object" && "__vinext_scrollY" in state);
}

export function restoreSynchronousPopstateScrollPosition(
  deps: SynchronousPopstateScrollRestoreDeps,
  state: unknown,
): void {
  const navId = deps.getActiveNavigationId();
  deps.markScrollRestoreConsumed(navId);
  deps.restorePopstateScrollPosition(state, {
    shouldContinue: () => deps.isCurrentNavigation(navId),
  });
}

function scheduleAfterFrame(callback: () => void): void {
  if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
    window.requestAnimationFrame(callback);
    return;
  }

  queueMicrotask(callback);
}

function createPopstateTraversalIntent(historyState: unknown): HistoryTraversalIntent {
  return {
    direction: "unknown",
    historyState,
    targetHistoryIndex: readHistoryStateTraversalIndex(historyState),
  };
}

export function createPopstateRestoreHandler(
  deps: BrowserPopstateRestoreDeps,
): (event: PopStateEvent) => void {
  return (event) => {
    const isRetainedHistoryNavigation = deps.shouldSuppressTransitionStart?.() === true;
    if (!isRetainedHistoryNavigation) {
      deps.notifyAppRouterTransitionStart(window.location.href);
    }
    if (deps.tryRestoreHistorySnapshot?.(event.state)) {
      deps.setPendingNavigation(null);
      deps.settleRetainedHistoryNavigation?.(Promise.resolve());
      return;
    }

    const navigate = deps.getNavigate();
    const pendingNavigation =
      navigate?.(
        window.location.href,
        0,
        "traverse",
        undefined,
        undefined,
        false,
        createPopstateTraversalIntent(event.state),
      ) ?? Promise.resolve();
    const popstateNavId = deps.getActiveNavigationId();

    deps.setPendingNavigation(pendingNavigation);
    deps.settleRetainedHistoryNavigation?.(pendingNavigation);
    const shouldRestoreSavedScroll = hasSavedScrollPosition(event.state);
    const shouldRestoreScrollForNavigation = () =>
      deps.isCurrentNavigation(popstateNavId) && !deps.shouldSkipScrollRestore(popstateNavId);

    if (shouldRestoreSavedScroll) {
      scheduleAfterFrame(() => {
        if (shouldRestoreScrollForNavigation()) {
          deps.restorePopstateScrollPosition(event.state, {
            shouldContinue: shouldRestoreScrollForNavigation,
          });
        }
      });
    }

    void pendingNavigation.finally(() => {
      if (shouldRestoreScrollForNavigation() && !shouldRestoreSavedScroll) {
        deps.restorePopstateScrollPosition(event.state);
      }

      if (deps.getPendingNavigation() === pendingNavigation) {
        deps.setPendingNavigation(null);
      }
    });
  };
}
