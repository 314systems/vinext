const APP_BROWSER_SUPPLEMENTAL_REFRESH_TIMEOUT_MS = 10_000;

export type SupplementalRefreshResult<T> = {
  degraded: boolean;
  value: Awaited<T>;
};

export type SupplementalRefreshHandle = {
  finish(): void;
  signal: AbortSignal;
};

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
