import type { FetchCacheMode } from "vinext/shims/fetch-cache";
import {
  ensureFetchPatch,
  runWithFetchDedupe,
  setCurrentFetchSoftTags,
} from "vinext/shims/fetch-cache-hooks";
import { getRequestExecutionContext } from "vinext/shims/request-context";
import { createRequestContext, runWithRequestContext } from "vinext/shims/unified-request-context";
import { readAppPageCacheResponse } from "./app-page-cache.js";
import { renderAppPageCacheArtifacts } from "./app-page-cache-render.js";
import { createStaticGenerationHeadersContext } from "./app-static-generation.js";
import { buildAppPageTags } from "./implicit-tags.js";

export { readAppPageCacheResponse, renderAppPageCacheArtifacts };

export type RunAppPageRevalidationContextOptions = {
  cleanPathname: string;
  currentFetchCacheMode?: FetchCacheMode | null;
  displayPathname?: string;
  draftModeSecret: string;
  dynamicConfig?: string;
  params: Record<string, string | string[]>;
  routePattern: string;
  routeSegments: readonly string[];
  setNavigationContext(context: {
    params: Record<string, string | string[]>;
    pathname: string;
    searchParams: URLSearchParams;
  }): void;
};

export async function runAppPageRevalidationContext<
  TResult extends {
    html: string;
    tags: string[];
  },
>(
  options: RunAppPageRevalidationContextOptions,
  renderFn: () => Promise<TResult>,
): Promise<TResult> {
  const headersContext = createStaticGenerationHeadersContext({
    draftModeSecret: options.draftModeSecret,
    dynamicConfig: options.dynamicConfig,
    routeKind: "page",
    routePattern: options.routePattern,
  });
  const requestContext = createRequestContext({
    headersContext,
    currentFetchCacheMode: options.currentFetchCacheMode ?? null,
    currentForceDynamicFetchDefault: options.dynamicConfig === "force-dynamic",
    executionContext: getRequestExecutionContext(),
    unstableCacheRevalidation: "foreground",
  });

  return runWithRequestContext(requestContext, async () => {
    ensureFetchPatch();
    setCurrentFetchSoftTags(buildAppPageTags(options.cleanPathname, [], options.routeSegments));
    options.setNavigationContext({
      pathname: options.displayPathname ?? options.cleanPathname,
      searchParams: new URLSearchParams(),
      params: options.params,
    });
    return await runWithFetchDedupe(renderFn);
  });
}
