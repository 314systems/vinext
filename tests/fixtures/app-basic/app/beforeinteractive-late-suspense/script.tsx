"use client";

import { use, useState } from "react";
import Script from "next/script";

const shellDelays = new Map<string, Promise<void>>();

function getShellDelay(key: string): Promise<void> {
  let delay = shellDelays.get(key);
  if (!delay) {
    delay = new Promise((resolve) => setTimeout(resolve, 1000));
    shellDelays.set(key, delay);
  }
  return delay;
}

declare global {
  interface Window {
    __vinextLateBeforeReadyCalls?: number;
    __vinextLateBeforeScriptExecutions?: number;
  }
}

function LateScript(): React.ReactElement {
  return (
    <Script
      id="app-late-before-ready"
      strategy="beforeInteractive"
      onReady={() => {
        window.__vinextLateBeforeReadyCalls = (window.__vinextLateBeforeReadyCalls ?? 0) + 1;
      }}
    >
      {`window.__vinextLateBeforeScriptExecutions =
        (window.__vinextLateBeforeScriptExecutions || 0) + 1;`}
    </Script>
  );
}

export function LateBeforeInteractive({ delayKey }: { delayKey: string }): React.ReactElement {
  use(getShellDelay(delayKey));
  const [mounted, setMounted] = useState(true);

  return (
    <section>
      {mounted ? <LateScript /> : null}
      <button type="button" onClick={() => setMounted((value) => !value)}>
        Toggle late script
      </button>
    </section>
  );
}
