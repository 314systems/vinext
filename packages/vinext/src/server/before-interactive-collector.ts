import React from "react";
import {
  BeforeInteractiveContext,
  type BeforeInteractiveInlineScript,
} from "vinext/shims/before-interactive-context";

export type BeforeInteractiveCollector = {
  scripts: BeforeInteractiveInlineScript[];
  wrapPageElement: (element: React.ReactElement) => React.ReactElement;
};

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
