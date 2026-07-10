export const SERVER_ACTION_CACHE_CONTROL = "no-cache, no-store, max-age=0, must-revalidate";
export const UNRECOGNIZED_ACTION_CACHE_CONTROL = "no-cache, must-revalidate";
const SERVER_ACTION_RESPONSE_HEADER = "x-vinext-server-action-response";

function updateServerActionCacheControl(response: Response, keepMarker: boolean): Response {
  const updateHeaders = (headers: Headers): void => {
    headers.set("Cache-Control", SERVER_ACTION_CACHE_CONTROL);
    headers.delete("CDN-Cache-Control");
    headers.delete("Cloudflare-CDN-Cache-Control");
    headers.delete("Cache-Tag");
    if (keepMarker) {
      headers.set(SERVER_ACTION_RESPONSE_HEADER, "1");
    } else {
      headers.delete(SERVER_ACTION_RESPONSE_HEADER);
    }
  };

  try {
    updateHeaders(response.headers);
    return response;
  } catch {
    const headers = new Headers(response.headers);
    updateHeaders(headers);
    return new Response(response.body, {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
  }
}

/**
 * Server Action responses are never cacheable. Next.js applies this policy
 * before action dispatch, so it is preserved for successes and every error
 * path, including progressive page renders.
 */
export function applyServerActionCacheControl(response: Response): Response {
  return updateServerActionCacheControl(response, true);
}

/** Reassert the action policy after outer response headers have been merged. */
export function finalizeServerActionCacheControl(response: Response): Response {
  return updateServerActionCacheControl(response, false);
}

export function isServerActionResponse(response: Pick<Response, "headers">): boolean {
  return response.headers.get(SERVER_ACTION_RESPONSE_HEADER) === "1";
}
