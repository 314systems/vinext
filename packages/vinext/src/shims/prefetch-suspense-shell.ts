import { getOrCreateAls } from "./internal/als-registry.js";
import { makeHangingPromise } from "./internal/make-hanging-promise.js";

type PrefetchSuspenseShellState = {
  dynamicAbortController: AbortController;
  reactAbortController: AbortController;
  abortScheduled: boolean;
  route: string;
};

const prefetchSuspenseShellAls = getOrCreateAls<PrefetchSuspenseShellState>(
  "vinext.prefetchSuspenseShell.als",
);

export function createPrefetchSuspenseShellState(route: string): PrefetchSuspenseShellState {
  return {
    dynamicAbortController: new AbortController(),
    reactAbortController: new AbortController(),
    abortScheduled: false,
    route,
  };
}

export function runWithPrefetchSuspenseShellState<T>(
  state: PrefetchSuspenseShellState,
  fn: () => T,
): T {
  return prefetchSuspenseShellAls.run(state, fn);
}

export function suspendPrefetchSuspenseShell(expression: string): Promise<never> | null {
  const state = prefetchSuspenseShellAls.getStore();
  if (!state) return null;

  if (!state.abortScheduled) {
    state.abortScheduled = true;
    setTimeout(() => {
      setTimeout(() => {
        state.reactAbortController.abort();
        state.dynamicAbortController.abort();
      }, 0);
    }, 0);
  }

  return makeHangingPromise(state.dynamicAbortController.signal, state.route, expression);
}
