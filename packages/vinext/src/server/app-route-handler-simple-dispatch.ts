import { mergeMiddlewareResponseHeaders } from "./middleware-response-headers.js";
import { reportRequestError } from "./instrumentation.js";

type SimpleRouteHandlerModule = {
  GET?: () => unknown;
};

type SimpleRouteHandlerMiddlewareContext = {
  headers: Headers | null;
  status: number | null;
};

type DispatchSimpleAppRouteHandlerOptions = {
  cleanPathname: string;
  clearRequestContext: () => void;
  middlewareContext: SimpleRouteHandlerMiddlewareContext;
  request: Request;
  route: {
    pattern: string;
    routeHandler: SimpleRouteHandlerModule;
  };
};

const VALID_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"]);

function applyMiddlewareContext(
  response: Response,
  middlewareContext: SimpleRouteHandlerMiddlewareContext,
): Response {
  if (!middlewareContext.headers && middlewareContext.status === null) return response;

  const headers = new Headers(response.headers);
  mergeMiddlewareResponseHeaders(headers, middlewareContext.headers);
  return new Response(response.body, {
    status: middlewareContext.status ?? response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function dispatchAppRouteHandler(
  options: DispatchSimpleAppRouteHandlerOptions,
): Promise<Response> {
  const method = options.request.method.toUpperCase();
  const handler = options.route.routeHandler;

  if (!VALID_METHODS.has(method)) {
    options.clearRequestContext();
    return applyMiddlewareContext(new Response(null, { status: 400 }), options.middlewareContext);
  }

  if (method === "OPTIONS") {
    options.clearRequestContext();
    return applyMiddlewareContext(
      new Response(null, {
        status: 204,
        headers: { Allow: "GET, HEAD, OPTIONS" },
      }),
      options.middlewareContext,
    );
  }

  const isHead = method === "HEAD";
  if ((method !== "GET" && !isHead) || typeof handler.GET !== "function") {
    options.clearRequestContext();
    return applyMiddlewareContext(new Response(null, { status: 405 }), options.middlewareContext);
  }

  try {
    const handlerFn = handler.GET;
    const response = await handlerFn();
    if (!(response instanceof Response)) {
      throw new TypeError(`Route handler ${options.route.pattern} did not return a Response`);
    }
    options.clearRequestContext();
    return applyMiddlewareContext(
      isHead
        ? new Response(null, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          })
        : response,
      options.middlewareContext,
    );
  } catch (error) {
    options.clearRequestContext();
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    console.error("[vinext] Route handler error:", error);
    void reportRequestError(
      normalizedError,
      {
        path: options.cleanPathname,
        method: options.request.method,
        headers: Object.fromEntries(options.request.headers.entries()),
      },
      {
        routerKind: "App Router",
        routePath: options.route.pattern,
        routeType: "route",
      },
    );
    return applyMiddlewareContext(new Response(null, { status: 500 }), options.middlewareContext);
  }
}
