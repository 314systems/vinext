import React from "react";
import {
  BeforeInteractiveContext,
  type BeforeInteractiveInlineScript,
} from "vinext/shims/before-interactive-context";

export type BeforeInteractiveCollector = {
  scripts: BeforeInteractiveInlineScript[];
  wrapPageElement: (element: React.ReactElement) => React.ReactElement;
};

type PagesRenderStream = ReadableStream<Uint8Array> & {
  allReady?: Promise<unknown>;
};

export async function waitForBeforeInteractiveCollection(
  stream: ReadableStream<Uint8Array>,
): Promise<void> {
  await (stream as PagesRenderStream).allReady;
}

export function createBeforeInteractiveCollector(
  context: typeof BeforeInteractiveContext = BeforeInteractiveContext,
): BeforeInteractiveCollector {
  const scripts: BeforeInteractiveInlineScript[] = [];

  return {
    scripts,
    wrapPageElement(element) {
      return React.createElement(
        context.Provider,
        {
          value(script: BeforeInteractiveInlineScript) {
            scripts.push(script);
          },
        },
        element,
      );
    },
  };
}
