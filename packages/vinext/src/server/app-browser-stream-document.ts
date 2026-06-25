import { decodeRscEmbeddedChunk, type RscEmbeddedChunk } from "./app-rsc-embedded-chunks.js";

type DocumentRscBootstrap = {
  done?: boolean;
  rsc: RscEmbeddedChunk[];
};

type DocumentNavigationRuntime = {
  bootstrap?: {
    rsc?: DocumentRscBootstrap;
  };
};

type VinextDocumentBrowserGlobals = {
  __VINEXT_RSC_CHUNKS__?: RscEmbeddedChunk[];
  __VINEXT_RSC_DONE__?: boolean;
};

const NAVIGATION_RUNTIME_KEY = Symbol.for("vinext.navigationRuntime");

export function getVinextBrowserGlobal(): typeof globalThis & VinextDocumentBrowserGlobals {
  return globalThis as typeof globalThis & VinextDocumentBrowserGlobals;
}

function getDocumentRscBootstrap(): DocumentRscBootstrap | null {
  if (typeof window === "undefined") return null;
  const runtime = Reflect.get(window, NAVIGATION_RUNTIME_KEY) as
    | DocumentNavigationRuntime
    | undefined;
  const rsc = runtime?.bootstrap?.rsc;
  return rsc && Array.isArray(rsc.rsc) ? rsc : null;
}

function createUnexpectedRscStreamCloseError(): Error {
  return new Error(
    "The connection to the page was unexpectedly closed, possibly due to the stop button being clicked, loss of Wi-Fi, or an unstable internet connection.",
  );
}

export function chunksToReadableStream(
  chunks: readonly RscEmbeddedChunk[],
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(decodeRscEmbeddedChunk(chunk));
      }
      controller.close();
    },
  });
}

export function createProgressiveRscStream(): ReadableStream<Uint8Array> {
  let cancelStream: (() => void) | undefined;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const vinext = getVinextBrowserGlobal();
      const runtimeRsc = getDocumentRscBootstrap();
      const initialChunks = runtimeRsc?.rsc ?? vinext.__VINEXT_RSC_CHUNKS__ ?? [];

      for (const chunk of initialChunks) {
        controller.enqueue(decodeRscEmbeddedChunk(chunk));
      }

      if (runtimeRsc?.done || vinext.__VINEXT_RSC_DONE__) {
        controller.close();
        return;
      }

      let closed = false;
      let cancelDocumentCompletionCheck: (() => void) | undefined;
      const cancelPendingDocumentCompletionCheck = () => {
        const cancel = cancelDocumentCompletionCheck;
        cancelDocumentCompletionCheck = undefined;
        cancel?.();
      };
      const closeOnce = () => {
        if (!closed) {
          closed = true;
          cancelPendingDocumentCompletionCheck();
          controller.close();
        }
      };
      const scheduleCloseOnce = () => {
        if (typeof queueMicrotask === "function") {
          queueMicrotask(closeOnce);
        } else {
          void Promise.resolve().then(closeOnce);
        }
      };
      const errorOnce = () => {
        if (!closed) {
          closed = true;
          cancelPendingDocumentCompletionCheck();
          controller.error(createUnexpectedRscStreamCloseError());
        }
      };
      cancelStream = () => {
        if (!closed) {
          closed = true;
          cancelPendingDocumentCompletionCheck();
        }
      };

      const liveRuntimeRsc = getDocumentRscBootstrap();
      const chunks = liveRuntimeRsc?.rsc ?? (vinext.__VINEXT_RSC_CHUNKS__ ??= []);
      chunks.push = function (...nextChunks: RscEmbeddedChunk[]): number {
        const length = Array.prototype.push.apply(this, nextChunks);

        if (closed) return length;

        for (const chunk of nextChunks) {
          controller.enqueue(decodeRscEmbeddedChunk(chunk));
        }

        if (liveRuntimeRsc?.done || vinext.__VINEXT_RSC_DONE__) {
          closeOnce();
        }

        return length;
      };
      if (liveRuntimeRsc) {
        let done = Boolean(liveRuntimeRsc.done);
        Object.defineProperty(liveRuntimeRsc, "done", {
          configurable: true,
          enumerable: true,
          get() {
            return done;
          },
          set(value) {
            done = Boolean(value);
            if (done) scheduleCloseOnce();
          },
        });
      } else {
        let done = Boolean(vinext.__VINEXT_RSC_DONE__);
        Object.defineProperty(vinext, "__VINEXT_RSC_DONE__", {
          configurable: true,
          enumerable: true,
          get() {
            return done;
          },
          set(value) {
            done = Boolean(value);
            if (done) scheduleCloseOnce();
          },
        });
      }

      if (typeof document !== "undefined") {
        if (document.readyState === "loading") {
          document.addEventListener("DOMContentLoaded", errorOnce);
          cancelDocumentCompletionCheck = () =>
            document.removeEventListener("DOMContentLoaded", errorOnce);
        } else {
          const timeoutId = setTimeout(errorOnce);
          cancelDocumentCompletionCheck = () => clearTimeout(timeoutId);
        }
      }
    },
    cancel() {
      cancelStream?.();
    },
  });
}
