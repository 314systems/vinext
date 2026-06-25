/// <reference types="vite/client" />

import { createElement, startTransition, use, useEffect } from "react";
import { createFromReadableStream } from "@vitejs/plugin-rsc/browser";
import { hydrateRoot } from "react-dom/client";
import "../client/instrumentation-client.js";
import {
  chunksToReadableStream,
  createProgressiveRscStream,
  getVinextBrowserGlobal,
} from "./app-browser-stream-document.js";
import { normalizeAppElements, type AppElements, type AppWireElements } from "./app-elements.js";
import { readAppElementsRouteId } from "./app-elements-route.js";
import { ElementsContext, Slot } from "virtual:vinext-app-slot-runtime";
import { installWindowNext } from "../client/window-next.js";

function decodeAppElementsPromise(payload: Promise<AppWireElements>): Promise<AppElements> {
  return Promise.resolve(payload).then((elements) => normalizeAppElements(elements));
}

function BrowserRoot({ initialElements }: { initialElements: Promise<AppElements> }) {
  const elements = use(initialElements);
  const routeId = readAppElementsRouteId(elements);

  useEffect(() => {
    const hydratedAt = performance.now();
    window.__VINEXT_HYDRATED_AT = hydratedAt;
    window.__NEXT_HYDRATED = true;
    window.__NEXT_HYDRATED_AT = hydratedAt;
    window.__NEXT_HYDRATED_CB?.();
  }, []);

  return createElement(
    ElementsContext.Provider,
    { value: elements },
    createElement(Slot, { id: routeId }),
  );
}

function readInitialRscStream(): ReadableStream<Uint8Array> {
  const browserGlobal = getVinextBrowserGlobal();
  if (browserGlobal.__VINEXT_RSC_DONE__) {
    return chunksToReadableStream(browserGlobal.__VINEXT_RSC_CHUNKS__ ?? []);
  }
  return createProgressiveRscStream();
}

function main(): void {
  if (window.__VINEXT_RSC_ROOT__ || window.__VINEXT_RSC_BOOTSTRAP_STATE__) return;
  window.__VINEXT_RSC_BOOTSTRAP_STATE__ = "starting";

  const initialElements = decodeAppElementsPromise(
    createFromReadableStream<AppWireElements>(readInitialRscStream()),
  );
  const children = createElement(BrowserRoot, { initialElements });

  startTransition(() => {
    window.__VINEXT_RSC_ROOT__ = hydrateRoot(document, children);
  });
  window.__VINEXT_RSC_BOOTSTRAP_STATE__ = "hydrated";
}

if (typeof document !== "undefined") {
  installWindowNext({ appDir: true });
  main();
}
