import { describe, expect, it, vi } from "vite-plus/test";
import { createViewportPrefetchScheduler } from "../packages/vinext/src/shims/internal/viewport-prefetch-scheduler.js";

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("viewport prefetch scheduler", () => {
  it("matches Next.js viewport bandwidth and cancellation semantics", async () => {
    // Ported from Next.js:
    // packages/next/src/client/components/segment-cache/scheduler.ts
    // test/e2e/app-dir/segment-cache/prefetch-scheduling/prefetch-scheduling.test.ts
    const scheduler = createViewportPrefetchScheduler();
    const requests = Array.from({ length: 6 }, () => deferred());
    const starts = requests.map((request) => vi.fn(() => request.promise));
    const tasks = starts.map((start) => scheduler.schedule(start));

    expect(starts.map((start) => start.mock.calls.length)).toEqual([1, 1, 1, 1, 0, 0]);

    tasks[4]?.cancel();
    requests[0]?.resolve();
    await requests[0]?.promise;
    await Promise.resolve();

    expect(starts[4]).not.toHaveBeenCalled();
    expect(starts[5]).toHaveBeenCalledOnce();

    tasks[0]?.cancel();
    requests[1]?.resolve();
    await requests[1]?.promise;
    await Promise.resolve();

    expect(starts[1]).toHaveBeenCalledOnce();
  });

  it("reschedules a cancelled viewport prefetch after re-entry", async () => {
    const scheduler = createViewportPrefetchScheduler(1);
    const blocker = deferred();
    scheduler.schedule(() => blocker.promise);

    const firstAttempt = vi.fn(() => Promise.resolve());
    scheduler.schedule(firstAttempt).cancel();
    const secondAttempt = vi.fn(() => Promise.resolve());
    scheduler.schedule(secondAttempt);

    blocker.resolve();
    await blocker.promise;
    await Promise.resolve();
    await Promise.resolve();

    expect(firstAttempt).not.toHaveBeenCalled();
    expect(secondAttempt).toHaveBeenCalledOnce();
  });

  it("drains the 59-link Next.js memory-pressure shape without flooding requests", async () => {
    // Ported from Next.js:
    // test/e2e/app-dir/segment-cache/memory-pressure/app/memory-pressure/page.tsx
    const scheduler = createViewportPrefetchScheduler();
    let activeRequests = 0;
    let peakActiveRequests = 0;
    const starts: number[] = [];
    const completions: number[] = [];

    const tasks = Array.from({ length: 59 }, (_, index) =>
      scheduler.schedule(async () => {
        starts.push(index);
        activeRequests += 1;
        peakActiveRequests = Math.max(peakActiveRequests, activeRequests);
        await new Promise((resolve) => setTimeout(resolve, 1));
        activeRequests -= 1;
        completions.push(index);
      }),
    );

    expect(starts).toHaveLength(4);
    expect(tasks).toHaveLength(59);

    await vi.waitFor(() => {
      expect(completions).toHaveLength(59);
    });

    expect(peakActiveRequests).toBe(4);
    expect(activeRequests).toBe(0);
  });
});
