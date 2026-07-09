type BeforeInteractiveRuntimeRecord = [src: string | 0, props: Record<string, unknown>];

type BeforeInteractiveRuntimeScope = {
  __next_s?: BeforeInteractiveRuntimeRecord[];
};

type RuntimeScript = Pick<
  HTMLScriptElement,
  "setAttribute" | "src" | "text" | "onload" | "onerror"
>;

type RuntimeDocument = {
  createElement(tagName: "script"): RuntimeScript;
  head: { appendChild(script: RuntimeScript): unknown };
};

export async function loadBeforeInteractiveRuntimeRecords(
  scope: BeforeInteractiveRuntimeScope = self as BeforeInteractiveRuntimeScope,
  runtimeDocument: RuntimeDocument = document as unknown as RuntimeDocument,
): Promise<void> {
  const records = scope.__next_s ?? [];
  let pending = Promise.resolve();
  const loadRecord = ([src, props]: BeforeInteractiveRuntimeRecord): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const script = runtimeDocument.createElement("script");
      for (const [name, value] of Object.entries(props)) {
        if (name === "children" || value === undefined) continue;
        if (name === "className" && typeof value === "string") {
          script.setAttribute("class", value);
        } else if (typeof value === "string" || typeof value === "number") {
          script.setAttribute(name, String(value));
        } else if (typeof value === "boolean" && value) {
          script.setAttribute(name, "");
        }
      }
      if (src) {
        script.src = src;
        script.onload = () => resolve();
        script.onerror = reject;
      } else {
        script.text = typeof props.children === "string" ? props.children : "";
      }
      runtimeDocument.head.appendChild(script);
      if (!src) queueMicrotask(resolve);
    });
  const enqueueRecord = (record: BeforeInteractiveRuntimeRecord): void => {
    pending = pending
      .then(() => loadRecord(record))
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
