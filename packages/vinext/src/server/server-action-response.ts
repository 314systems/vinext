export const SERVER_ACTION_CACHE_CONTROL = "no-cache, no-store, max-age=0, must-revalidate";
export const UNRECOGNIZED_ACTION_CACHE_CONTROL = "no-cache, must-revalidate";

/**
 * Server Action responses are never cacheable. Next.js applies this policy
 * before action dispatch, so it is preserved for successes and every error
 * path, including progressive page renders.
 */
export function applyServerActionCacheControl(response: Response): Response {
  try {
    response.headers.set("Cache-Control", SERVER_ACTION_CACHE_CONTROL);
    response.headers.delete("CDN-Cache-Control");
    response.headers.delete("Cloudflare-CDN-Cache-Control");
    response.headers.delete("Cache-Tag");
    return response;
  } catch {
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", SERVER_ACTION_CACHE_CONTROL);
    headers.delete("CDN-Cache-Control");
    headers.delete("Cloudflare-CDN-Cache-Control");
    headers.delete("Cache-Tag");
    return new Response(response.body, {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
  }
}
