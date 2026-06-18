import { describe, expect, it, vi } from "vitest";
import { dispatchAppRouteHandler } from "../packages/vinext/src/server/app-route-handler-simple-dispatch.js";

function dispatch(
  method: string,
  get: () => unknown = () => new Response("ok"),
  middlewareContext: { headers: Headers | null; status: number | null } = {
    headers: null,
    status: null,
  },
) {
  const clearRequestContext = vi.fn();
  return {
    clearRequestContext,
    response: dispatchAppRouteHandler({
      cleanPathname: "/api/health",
      clearRequestContext,
      middlewareContext,
      request: new Request("https://example.com/api/health", { method }),
      route: {
        pattern: "/api/health",
        routeHandler: { GET: get },
      },
    }),
  };
}

describe("simple App route handler dispatch", () => {
  it("serves GET and auto-HEAD responses", async () => {
    const get = vi.fn(() => new Response("body", { headers: { "X-Test": "yes" } }));
    const getResult = dispatch("GET", get);
    const getResponse = await getResult.response;
    expect(await getResponse.text()).toBe("body");
    expect(getResult.clearRequestContext).toHaveBeenCalledOnce();

    const headResult = dispatch("HEAD", get);
    const headResponse = await headResult.response;
    expect(await headResponse.text()).toBe("");
    expect(headResponse.headers.get("X-Test")).toBe("yes");
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("auto-responds to OPTIONS and rejects unsupported methods", async () => {
    // Ported from Next.js: test/e2e/app-dir/app-routes/app-custom-routes.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-routes/app-custom-routes.test.ts
    const optionsResult = dispatch("OPTIONS");
    const optionsResponse = await optionsResult.response;
    expect(optionsResponse.status).toBe(204);
    expect(optionsResponse.headers.get("Allow")).toBe("GET, HEAD, OPTIONS");

    expect((await dispatch("POST").response).status).toBe(405);
    expect((await dispatch("HEADER").response).status).toBe(400);
  });

  it("applies middleware response headers and status", async () => {
    const result = dispatch(
      "GET",
      () => new Response("ok", { headers: { Vary: "Accept-Encoding" } }),
      {
        headers: new Headers({ "X-Middleware": "yes", Vary: "RSC" }),
        status: 202,
      },
    );
    const response = await result.response;
    expect(response.status).toBe(202);
    expect(response.headers.get("X-Middleware")).toBe("yes");
    expect(response.headers.get("Vary")).toBe("Accept-Encoding, RSC");
  });
});
