import { RequestCookies, ResponseCookies } from "vinext/shims/internal/cookies";
import { patternToNextFormat } from "../routing/route-validation.js";
import { buildRequestHeadersFromMiddlewareResponse } from "../utils/middleware-request-headers.js";
import type { AppMiddlewareContext } from "./app-middleware.js";
import { ACTION_FORWARDED_HEADER } from "./headers.js";
import {
  createServerActionNotFoundResponse,
  getServerActionNotFoundMessage,
} from "./server-action-not-found.js";

const ACTION_FORWARD_FORBIDDEN_HEADERS = new Set([
  "accept-encoding",
  "keepalive",
  "keep-alive",
  "content-encoding",
  "transfer-encoding",
  "connection",
  "expect",
  "content-length",
  "set-cookie",
]);

type ActionOwnerManifest = Readonly<Record<string, readonly string[]>>;

type ForwardServerActionOptions = {
  actionId: string;
  actionOwners: ActionOwnerManifest | null;
  basePath: string;
  clearRequestContext: () => void;
  currentRoutePattern: string | null;
  dispatch: (request: Request) => Promise<Response>;
  middlewareContext: AppMiddlewareContext;
  request: Request;
};

function mergeActionForwardCookies(requestHeaders: Headers, responseHeaders: Headers): void {
  const requestCookies = new RequestCookies(requestHeaders);
  const responseCookies = new ResponseCookies(responseHeaders);
  for (const cookie of responseCookies.getAll()) {
    if (cookie.value === undefined) requestCookies.delete(cookie.name);
    else requestCookies.set(cookie);
  }
  requestHeaders.set("cookie", requestCookies.toString());
}

function buildActionForwardHeaders(
  request: Request,
  middlewareContext: AppMiddlewareContext,
): Headers {
  const middlewareRequestHeaders = middlewareContext.requestHeaders ?? middlewareContext.headers;
  const headers = middlewareRequestHeaders
    ? (buildRequestHeadersFromMiddlewareResponse(request.headers, middlewareRequestHeaders, {
        preserveCredentialHeaders: true,
      }) ?? new Headers(request.headers))
    : new Headers(request.headers);

  for (const [key, value] of middlewareContext.headers ?? []) {
    headers.set(key, value);
  }
  if (middlewareContext.headers) {
    mergeActionForwardCookies(headers, middlewareContext.headers);
  }
  for (const key of ACTION_FORWARD_FORBIDDEN_HEADERS) {
    headers.delete(key);
  }
  return headers;
}

function filterActionForwardResponse(response: Response): Response {
  const headers = new Headers();
  for (const [key, value] of response.headers) {
    if (!ACTION_FORWARD_FORBIDDEN_HEADERS.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  }
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

function emptyActionForwardResponse(): Response {
  return new Response("{}", { headers: { "content-type": "application/json" } });
}

function actionOwnerPatterns(
  actionOwners: ActionOwnerManifest,
  actionId: string,
): readonly string[] | undefined {
  if (Object.hasOwn(actionOwners, actionId)) return actionOwners[actionId];
  const moduleId = actionId.split("#", 1)[0]!;
  return Object.hasOwn(actionOwners, moduleId) ? actionOwners[moduleId] : undefined;
}

export async function forwardServerActionIfNeeded(
  options: ForwardServerActionOptions,
): Promise<Response | null> {
  if (!options.actionOwners) return null;

  const ownerPatterns = actionOwnerPatterns(options.actionOwners, options.actionId);
  if (
    ownerPatterns &&
    options.currentRoutePattern &&
    ownerPatterns.includes(options.currentRoutePattern)
  ) {
    return null;
  }

  const ownerPath = ownerPatterns?.[0];
  if (!ownerPath || options.request.headers.get(ACTION_FORWARDED_HEADER)) {
    console.warn(getServerActionNotFoundMessage(options.actionId));
    options.clearRequestContext();
    return createServerActionNotFoundResponse();
  }

  const forwardUrl = new URL(options.request.url);
  forwardUrl.pathname =
    options.basePath + (ownerPath === "/" ? "" : patternToNextFormat(ownerPath));
  forwardUrl.search = "";
  const forwardRequest = new Request(forwardUrl, {
    body: options.request.body,
    duplex: "half",
    headers: buildActionForwardHeaders(options.request, options.middlewareContext),
    method: "POST",
  } as RequestInit & { duplex: "half" });

  let forwardResponse: Response;
  try {
    forwardResponse = await options.dispatch(forwardRequest);
  } catch (error) {
    console.error("[vinext] Failed to forward server action:", error);
    options.clearRequestContext();
    return emptyActionForwardResponse();
  }

  if (forwardResponse.headers.get("content-type")?.startsWith("text/x-component")) {
    return filterActionForwardResponse(forwardResponse);
  }
  await forwardResponse.body?.cancel();
  return emptyActionForwardResponse();
}
