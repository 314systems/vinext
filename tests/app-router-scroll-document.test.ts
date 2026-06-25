import React from "react";
import { renderToStaticMarkup } from "react-dom/server.edge";
import { describe, expect, it } from "vite-plus/test";
import {
  AppRouterScrollCommitProvider,
  AppRouterScrollTarget,
} from "../packages/vinext/src/shims/app-router-scroll-document.js";

describe("document-only App Router scroll wrappers", () => {
  it("preserves children without client-side scroll state", () => {
    const html = renderToStaticMarkup(
      React.createElement(
        AppRouterScrollCommitProvider,
        { commitId: 1 },
        React.createElement(
          AppRouterScrollTarget,
          null,
          React.createElement("main", null, "document navigation"),
        ),
      ),
    );

    expect(html).toBe("<main>document navigation</main>");
  });
});
