import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createSupplementalRefreshCoordinator,
  resolvePersistedSourcePageRefresh,
  resolveSupplementalRefreshes,
  settleSuccessfulServerActionResult,
  shouldScheduleSupplementalRefreshRecovery,
} from "../packages/vinext/src/server/app-browser-supplemental-refresh.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("server action supplemental refreshes", () => {
  // Matches Next.js action discarding: test/e2e/app-dir/actions/app-action.test.ts
  // and packages/next/src/client/components/app-router-instance.ts.
  it("retains the exact source query while refreshing an intercepted URL", () => {
    expect(
      resolvePersistedSourcePageRefresh({
        basePath: "",
        refreshUrl: new URL("https://example.com/refreshing/login?modal=new"),
        state: {
          previousNextUrl: "/refreshing?random=old",
          slotBindings: [],
        },
      }),
    ).toBe("/refreshing?random=old");
  });

  it("recovers the active children route when no interception source URL exists", () => {
    expect(
      resolvePersistedSourcePageRefresh({
        basePath: "/docs",
        refreshUrl: new URL("https://example.com/docs/nested-revalidate/modal?view=current"),
        state: {
          previousNextUrl: null,
          slotBindings: [
            {
              activeRouteId: "route:/nested-revalidate",
              ownerLayoutId: "layout:/nested-revalidate",
              slotId: "slot:children:/nested-revalidate",
              state: "active",
            },
            {
              activeRouteId: "route:/nested-revalidate/drawer",
              ownerLayoutId: "layout:/nested-revalidate",
              slotId: "slot:drawer:/nested-revalidate",
              state: "active",
            },
          ],
        },
      }),
    ).toBe("/docs/nested-revalidate?view=current");
  });

  it("does not replace a normal traversal target with an unrelated source page", () => {
    expect(
      resolvePersistedSourcePageRefresh({
        basePath: "",
        refreshUrl: new URL("https://example.com/detail-page"),
        state: {
          previousNextUrl: null,
          slotBindings: [
            {
              activeRouteId: "route:/",
              ownerLayoutId: "layout:/",
              slotId: "slot:children:/",
              state: "active",
            },
            {
              activeRouteId: "route:/",
              ownerLayoutId: "layout:/",
              slotId: "slot:interception:/",
              state: "active",
            },
          ],
        },
      }),
    ).toBeNull();
  });

  it("merges multiple successful persisted slots", async () => {
    const result = await resolveSupplementalRefreshes({
      merge: (current, supplemental) => [...current, ...supplemental],
      primary: Promise.resolve(["children"]),
      signal: new AbortController().signal,
      supplemental: [async () => ["modal"], async () => ["drawer"]],
    });

    expect(result).toEqual({
      degraded: false,
      value: ["children", "modal", "drawer"],
    });
  });

  it("keeps the primary action payload when a supplemental request fails", async () => {
    let siblingAborted = false;
    const result = await resolveSupplementalRefreshes({
      merge: (current, supplemental) => current + supplemental,
      primary: Promise.resolve("children"),
      signal: new AbortController().signal,
      supplemental: [
        async () => {
          throw new Error("slot failed");
        },
        (signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                siblingAborted = true;
                reject(signal.reason);
              },
              { once: true },
            );
          }),
      ],
    });

    expect(result).toEqual({ degraded: true, value: "children" });
    expect(siblingAborted).toBe(true);
  });

  it("times out a hanging supplemental request without blocking the action", async () => {
    vi.useFakeTimers();
    const resultPromise = resolveSupplementalRefreshes({
      merge: (current, supplemental) => current + supplemental,
      primary: Promise.resolve("children"),
      signal: new AbortController().signal,
      supplemental: [
        (signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
      ],
      timeoutMs: 25,
    });

    await vi.advanceTimersByTimeAsync(25);
    await expect(resultPromise).resolves.toEqual({ degraded: true, value: "children" });
  });

  it("settles a successful action value before a hanging supplemental navigation", async () => {
    const navigation = new Promise<never>(() => {});
    const onNavigationFailure = vi.fn();

    await expect(
      settleSuccessfulServerActionResult({
        navigation,
        onNavigationFailure,
        value: "action-value",
      }),
    ).resolves.toBe("action-value");
    expect(onNavigationFailure).not.toHaveBeenCalled();
  });

  it("keeps degraded recovery bounded and atomic when a supplemental fails", async () => {
    const result = await resolveSupplementalRefreshes({
      merge: (current, supplemental) => [...current, ...supplemental],
      primary: Promise.resolve(["children"]),
      signal: new AbortController().signal,
      supplemental: [
        async () => ["modal"],
        async () => {
          throw new Error("drawer failed");
        },
      ],
    });

    expect(result).toEqual({ degraded: true, value: ["children"] });
  });

  it("recovers from detached navigation failure after settling the action", async () => {
    const onNavigationFailure = vi.fn();

    await expect(
      settleSuccessfulServerActionResult({
        navigation: Promise.reject(new Error("supplemental failed")),
        onNavigationFailure,
        value: "action-value",
      }),
    ).resolves.toBe("action-value");
    await vi.waitFor(() => expect(onNavigationFailure).toHaveBeenCalledTimes(1));
  });

  it("stops waiting when a newer navigation supersedes the action", async () => {
    const coordinator = createSupplementalRefreshCoordinator();
    const refresh = coordinator.begin({ activeNavigationId: 4, startedNavigationId: 4 });
    let supplementalAborted = false;
    const resultPromise = resolveSupplementalRefreshes({
      merge: (current, supplemental) => current + supplemental,
      primary: Promise.resolve("children"),
      signal: refresh.signal,
      supplemental: [
        (signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                supplementalAborted = true;
                reject(signal.reason);
              },
              { once: true },
            );
          }),
      ],
    });

    coordinator.abortAll();

    await expect(resultPromise).resolves.toEqual({ degraded: true, value: "children" });
    expect(supplementalAborted).toBe(true);
    refresh.finish();
  });

  it("does not start supplemental work for an already-superseded action", async () => {
    const coordinator = createSupplementalRefreshCoordinator();
    const refresh = coordinator.begin({ activeNavigationId: 5, startedNavigationId: 4 });
    const load = vi.fn(async () => "modal");

    await expect(
      resolveSupplementalRefreshes({
        merge: (current, supplemental) => current + supplemental,
        primary: Promise.resolve("children"),
        signal: refresh.signal,
        supplemental: [load],
      }),
    ).resolves.toEqual({ degraded: true, value: "children" });
    expect(load).not.toHaveBeenCalled();
    refresh.finish();
  });

  it("recovers active degraded actions without replacing a superseding navigation", () => {
    expect(
      shouldScheduleSupplementalRefreshRecovery({
        activeNavigationId: 4,
        degraded: true,
        startedNavigationId: 4,
      }),
    ).toBe(true);
    expect(
      shouldScheduleSupplementalRefreshRecovery({
        activeNavigationId: 5,
        degraded: true,
        startedNavigationId: 4,
      }),
    ).toBe(false);
  });
});
