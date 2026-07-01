import { describe, expect, it, vi } from "vite-plus/test";
import {
  createLinkSegmentPrefetchScheduler,
  type LinkSegmentPrefetchInstance,
  type LinkSegmentPrefetchPhaseRequest,
} from "../packages/vinext/src/shims/internal/link-segment-prefetch-scheduler.js";

function createDeferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  if (resolve === undefined) {
    throw new Error("Expected deferred resolver to be initialized");
  }
  return { promise, resolve };
}

async function flushScheduler(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

function createInstance(href: string): LinkSegmentPrefetchInstance {
  return {
    href,
    isVisible: true,
    pagesRouteHref: undefined,
  };
}

function createSchedulerHarness() {
  const requests: LinkSegmentPrefetchPhaseRequest[] = [];
  const deferredRequests: Array<ReturnType<typeof createDeferred>> = [];
  const runPhase = vi.fn((request: LinkSegmentPrefetchPhaseRequest) => {
    requests.push({ ...request });
    const deferred = createDeferred();
    deferredRequests.push(deferred);
    return deferred.promise;
  });
  const scheduler = createLinkSegmentPrefetchScheduler({ runPhase });

  return {
    deferredRequests,
    requests,
    runPhase,
    scheduler,
  };
}

describe("Link Segment Cache prefetch scheduler", () => {
  it("runs the route-tree phase before the segment phase", async () => {
    // Mirrors the phase split in Next.js's Segment Cache scheduler:
    // packages/next/src/client/components/segment-cache/scheduler.ts
    const { deferredRequests, requests, runPhase, scheduler } = createSchedulerHarness();
    const instance = createInstance("/dashboard");

    scheduler.schedule(instance, "low", 1);
    await flushScheduler();

    expect(runPhase).toHaveBeenCalledTimes(1);
    expect(requests[0]).toMatchObject({
      href: "/dashboard",
      phase: "route-tree",
      priority: "low",
    });

    deferredRequests[0]?.resolve();
    await flushScheduler();

    expect(runPhase).toHaveBeenCalledTimes(2);
    expect(requests[1]).toMatchObject({
      href: "/dashboard",
      phase: "segment",
      priority: "low",
    });
  });

  it("reschedules a running hover without double-running route-tree and upgrades segment priority", async () => {
    const { deferredRequests, requests, runPhase, scheduler } = createSchedulerHarness();
    const instance = createInstance("/reports");

    scheduler.schedule(instance, "low", 1);
    await flushScheduler();

    scheduler.schedule(instance, "high", 1);
    await flushScheduler();

    expect(runPhase).toHaveBeenCalledTimes(1);
    expect(requests[0]).toMatchObject({
      href: "/reports",
      phase: "route-tree",
      priority: "low",
    });

    deferredRequests[0]?.resolve();
    await flushScheduler();

    expect(runPhase).toHaveBeenCalledTimes(2);
    expect(requests[1]).toMatchObject({
      href: "/reports",
      phase: "segment",
      priority: "high",
    });
  });

  it("continues to the segment phase after visibility cancellation is rescheduled during route-tree", async () => {
    const { deferredRequests, requests, runPhase, scheduler } = createSchedulerHarness();
    const instance = createInstance("/feed");

    scheduler.schedule(instance, "low", 1);
    await flushScheduler();

    instance.isVisible = false;
    scheduler.cancel(instance);
    instance.isVisible = true;
    scheduler.schedule(instance, "low", 2);
    await flushScheduler();

    expect(runPhase).toHaveBeenCalledTimes(1);
    expect(requests[0]).toMatchObject({
      href: "/feed",
      phase: "route-tree",
      priority: "low",
    });

    deferredRequests[0]?.resolve();
    await flushScheduler();

    expect(runPhase).toHaveBeenCalledTimes(2);
    expect(requests[1]).toMatchObject({
      href: "/feed",
      phase: "segment",
      priority: "low",
    });
  });

  it("does not restart a completed task", async () => {
    const { deferredRequests, runPhase, scheduler } = createSchedulerHarness();
    const instance = createInstance("/settings");

    scheduler.schedule(instance, "low", 1);
    await flushScheduler();
    deferredRequests[0]?.resolve();
    await flushScheduler();
    deferredRequests[1]?.resolve();
    await flushScheduler();

    expect(runPhase).toHaveBeenCalledTimes(2);

    scheduler.schedule(instance, "high", 1);
    await flushScheduler();

    expect(runPhase).toHaveBeenCalledTimes(2);
  });

  it("starts low-priority route-tree work in batch order while preserving newest-first order within a batch", async () => {
    const { requests, runPhase, scheduler } = createSchedulerHarness();
    const firstBatch = createInstance("/batch-first");
    const secondBatchOlder = createInstance("/batch-second-older");
    const secondBatchNewer = createInstance("/batch-second-newer");
    const thirdBatch = createInstance("/batch-third");

    scheduler.schedule(firstBatch, "low", 1);
    scheduler.schedule(secondBatchOlder, "low", 2);
    scheduler.schedule(secondBatchNewer, "low", 2);
    scheduler.schedule(thirdBatch, "low", 3);
    await flushScheduler();

    expect(runPhase).toHaveBeenCalledTimes(4);
    expect(requests.map((request) => request.href)).toEqual([
      "/batch-first",
      "/batch-second-newer",
      "/batch-second-older",
      "/batch-third",
    ]);
    expect(requests.map((request) => request.phase)).toEqual([
      "route-tree",
      "route-tree",
      "route-tree",
      "route-tree",
    ]);
  });
});
