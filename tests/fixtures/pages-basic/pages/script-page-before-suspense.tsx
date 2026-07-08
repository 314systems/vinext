import { lazy, Suspense } from "react";
import Script from "next/script";

const SuspendedScript = lazy(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));

  return {
    default() {
      return (
        <Script
          id="page-before-suspense"
          src="/page-before-suspense-script.js"
          strategy="beforeInteractive"
        />
      );
    },
  };
});

export default function ScriptPageBeforeSuspense() {
  return (
    <main>
      <h1>Suspended Page Before Interactive</h1>
      <Suspense fallback={<p>Loading script</p>}>
        <SuspendedScript />
      </Suspense>
    </main>
  );
}
