export type ViewportPrefetchTask = {
  cancel(): void;
};

type QueuedViewportPrefetch = {
  cancelled: boolean;
  run: () => Promise<void>;
};

export function createViewportPrefetchScheduler(maxConcurrentRequests = 4): {
  schedule(run: () => Promise<void>): ViewportPrefetchTask;
} {
  const queue: QueuedViewportPrefetch[] = [];
  let activeRequests = 0;

  function processQueue(): void {
    while (activeRequests < maxConcurrentRequests && queue.length > 0) {
      const queued = queue.shift();
      if (!queued || queued.cancelled) continue;

      activeRequests += 1;
      void queued.run().finally(() => {
        activeRequests -= 1;
        processQueue();
      });
    }
  }

  return {
    schedule(run) {
      const queued: QueuedViewportPrefetch = { cancelled: false, run };
      queue.push(queued);
      processQueue();
      return {
        cancel() {
          queued.cancelled = true;
        },
      };
    },
  };
}
