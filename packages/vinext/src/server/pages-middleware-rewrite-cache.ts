export type PagesMiddlewareRewriteCacheState = {
  cachePathname: string;
  bypassCdnCache: boolean;
};

export function getPagesMiddlewareRewriteCacheState(
  routeUrl: string,
  hasMiddlewareRewrite: boolean,
): PagesMiddlewareRewriteCacheState {
  const url = new URL(routeUrl, "http://vinext.local");
  if (!hasMiddlewareRewrite || !url.search) {
    return { cachePathname: url.pathname || "/", bypassCdnCache: false };
  }

  url.searchParams.sort();
  return {
    cachePathname: `${url.pathname || "/"}?${url.searchParams.toString()}`,
    bypassCdnCache: true,
  };
}
