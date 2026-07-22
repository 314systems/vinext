import { AppElementsWire } from "./app-elements.js";
import type { AppRouterState } from "./app-browser-state.js";
import { addBasePathToPathname } from "../utils/base-path.js";

const APP_BROWSER_SUPPLEMENTAL_REFRESH_TIMEOUT_MS = 10_000;

export type SupplementalRefreshResult<T> = {
  degraded: boolean;
  value: Awaited<T>;
};

export type SupplementalRefreshHandle = {
  finish(): void;
  signal: AbortSignal;
};

export function resolvePersistedSourcePageRefresh(options: {
  basePath: string;
  refreshUrl: URL;
  state: Pick<AppRouterState, "previousNextUrl" | "slotBindings">;
}): string | null {
  let sourceUrl: URL;
  if (options.state.previousNextUrl !== null) {
    sourceUrl = new URL(options.state.previousNextUrl, options.refreshUrl);
  } else {
    const sourcePageBinding = options.state.slotBindings.find((binding) => {
      const parsedSlot = AppElementsWire.parseElementKey(binding.slotId);
      return (
        binding.state === "active" &&
        parsedSlot?.kind === "slot" &&
        parsedSlot.name === "children" &&
        binding.activeRouteId !== undefined
      );
    });
    const activeRoute = sourcePageBinding?.activeRouteId
      ? AppElementsWire.parseElementKey(sourcePageBinding.activeRouteId)
      : null;
    if (activeRoute?.kind !== "route") return null;
    const hasPersistedNamedSlot = options.state.slotBindings.some(
      (binding) =>
        binding.state === "active" &&
        binding.slotId !== sourcePageBinding?.slotId &&
        binding.activeRouteId !== undefined &&
        binding.activeRouteId !== sourcePageBinding?.activeRouteId,
    );
    if (!hasPersistedNamedSlot) return null;
    sourceUrl = new URL(
      addBasePathToPathname(activeRoute.path, options.basePath),
      options.refreshUrl,
    );
    sourceUrl.search = options.refreshUrl.search;
  }
  if (
    sourceUrl.pathname === options.refreshUrl.pathname &&
    sourceUrl.search === options.refreshUrl.search
  ) {
    return null;
  }
  return `${sourceUrl.pathname}${sourceUrl.search}`;
}

export function createSupplementalRefreshCoordinator(): {
  abortAll(): void;
  begin(options: {
    activeNavigationId: number;
    startedNavigationId: number;
  }): SupplementalRefreshHandle;
} {
  const controllers = new Set<AbortController>();
  return {
    abortAll() {
      for (const controller of controllers) controller.abort();
    },
    begin(options) {
      const controller = new AbortController();
      controllers.add(controller);
      if (options.activeNavigationId !== options.startedNavigationId) controller.abort();
      return {
        finish() {
          controllers.delete(controller);
        },
        signal: controller.signal,
      };
    },
  };
}

export function shouldScheduleSupplementalRefreshRecovery(options: {
  activeNavigationId: number;
  degraded: boolean;
  startedNavigationId: number;
}): boolean {
  return options.degraded && options.activeNavigationId === options.startedNavigationId;
}

export function settleSuccessfulServerActionResult<T>(options: {
  navigation: Promise<unknown>;
  onNavigationFailure: () => void;
  value: T;
}): Promise<T> {
  void options.navigation.catch(() => {
    options.onNavigationFailure();
  });
  return Promise.resolve(options.value);
}

export async function resolveSupplementalRefreshes<T>(options: {
  merge: (current: Awaited<T>, supplemental: Awaited<T>) => Awaited<T>;
  primary: Promise<T>;
  signal: AbortSignal;
  supplemental: ReadonlyArray<(signal: AbortSignal) => Promise<T>>;
  timeoutMs?: number;
}): Promise<SupplementalRefreshResult<T>> {
  if (options.supplemental.length === 0) {
    return { degraded: false, value: await options.primary };
  }

  const controller = new AbortController();
  const abort = () => controller.abort(options.signal.reason);
  if (options.signal.aborted) {
    abort();
  } else {
    options.signal.addEventListener("abort", abort, { once: true });
  }

  const timeout = setTimeout(
    () => controller.abort(new DOMException("Supplemental refresh timed out", "TimeoutError")),
    options.timeoutMs ?? APP_BROWSER_SUPPLEMENTAL_REFRESH_TIMEOUT_MS,
  );

  try {
    if (controller.signal.aborted) {
      return { degraded: true, value: await options.primary };
    }

    const supplemental = options.supplemental.map((load) => load(controller.signal));
    const [primary, supplementalValues] = await Promise.all([
      options.primary,
      Promise.all(supplemental),
    ]);
    let value = primary;
    for (const supplementalValue of supplementalValues) {
      value = options.merge(value, supplementalValue);
    }
    return {
      degraded: false,
      value,
    };
  } catch {
    controller.abort();
    return { degraded: true, value: await options.primary };
  } finally {
    clearTimeout(timeout);
    options.signal.removeEventListener("abort", abort);
  }
}
