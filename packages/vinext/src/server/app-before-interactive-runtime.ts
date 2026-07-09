import { loadedScripts, scriptCache, setScriptAttributes } from "vinext/shims/script-loader";

type BeforeInteractiveRuntimeRecord = [src: string | 0, props: Record<string, unknown>];

type BeforeInteractiveRuntimeScope = {
  __next_s?: BeforeInteractiveRuntimeRecord[];
};

type RuntimeScript = Pick<
  HTMLScriptElement,
  | "setAttribute"
  | "removeAttribute"
  | "src"
  | "text"
  | "onload"
  | "onerror"
  | "async"
  | "defer"
  | "noModule"
>;

type RuntimeDocument = {
  createElement(tagName: "script"): RuntimeScript;
  head: { appendChild(script: RuntimeScript): unknown };
};

type DeferredLoad = {
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
};

function createDeferredLoad(): DeferredLoad {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

export async function loadBeforeInteractiveRuntimeRecords(
  scope: BeforeInteractiveRuntimeScope = self as BeforeInteractiveRuntimeScope,
  runtimeDocument: RuntimeDocument = document as unknown as RuntimeDocument,
): Promise<void> {
  const records = scope.__next_s ?? [];
  let pending = Promise.resolve();
  const loadRecord = (
    [src, props]: BeforeInteractiveRuntimeRecord,
    deferredLoad?: DeferredLoad,
  ): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const script = runtimeDocument.createElement("script");
      setScriptAttributes(script as HTMLScriptElement, props);
      const key =
        (typeof props.id === "string" && props.id) || (typeof src === "string" && src) || "";
      if (src) {
        script.src = src;
        script.onload = () => {
          if (key) loadedScripts.add(key);
          deferredLoad?.resolve();
          resolve();
        };
        script.onerror = (error) => {
          deferredLoad?.reject(error);
          reject(error);
        };
      } else {
        script.text = typeof props.children === "string" ? props.children : "";
      }
      runtimeDocument.head.appendChild(script);
      if (!src) {
        if (key) loadedScripts.add(key);
        queueMicrotask(resolve);
      }
    });
  const enqueueRecord = (record: BeforeInteractiveRuntimeRecord): void => {
    const [src] = record;
    const deferredLoad = src ? createDeferredLoad() : undefined;
    if (src && deferredLoad) scriptCache.set(src, deferredLoad.promise);
    pending = pending
      .then(() => loadRecord(record, deferredLoad))
      .catch((error: unknown) => {
        console.error(error);
      });
  };

  const initialRecords = records.splice(0, records.length);
  const originalPush = records.push.bind(records);
  records.push = (...newRecords: BeforeInteractiveRuntimeRecord[]) => {
    const length = originalPush(...newRecords);
    for (const record of newRecords) enqueueRecord(record);
    return length;
  };
  scope.__next_s = records;

  for (const record of initialRecords) enqueueRecord(record);
  let observedPending = pending;
  while (true) {
    await observedPending;
    if (observedPending === pending) break;
    observedPending = pending;
  }
}
