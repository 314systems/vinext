import { describe, expect, it } from "vite-plus/test";
import {
  ErrorBoundary,
  ErrorBoundaryInner,
  ForbiddenBoundaryInner,
  ForbiddenBoundary,
  GlobalErrorBoundary,
  NotFoundBoundaryInner,
  NotFoundBoundary,
  RedirectErrorBoundary,
  RedirectBoundary,
  UnauthorizedBoundaryInner,
  UnauthorizedBoundary,
} from "../packages/vinext/src/shims/error-boundary-document.js";

describe("document-only error boundary exports", () => {
  it("provides the route-wiring boundary surface", () => {
    expect(
      [
        ErrorBoundary,
        ForbiddenBoundary,
        GlobalErrorBoundary,
        NotFoundBoundary,
        RedirectBoundary,
        UnauthorizedBoundary,
      ].every((value) => typeof value === "function"),
    ).toBe(true);
  });

  it("preserves navigation-signal and generic-error classification", () => {
    const redirect = Object.assign(new Error("redirect"), {
      digest: "NEXT_REDIRECT;replace;%2Flogin;307;",
    });
    const notFound = Object.assign(new Error("not found"), {
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    });
    const regular = new Error("regular");

    expect(() => ErrorBoundaryInner.getDerivedStateFromError(redirect)).toThrow(redirect);
    expect(() => ErrorBoundaryInner.getDerivedStateFromError(notFound)).toThrow(notFound);
    expect(ErrorBoundaryInner.getDerivedStateFromError(regular)).toEqual({
      error: { thrownValue: regular },
    });
    expect(RedirectErrorBoundary.getDerivedStateFromError(redirect)).toEqual({
      redirect: "/login",
      type: "replace",
    });
  });

  it("preserves access-fallback classification", () => {
    const error = (status: number) =>
      Object.assign(new Error(String(status)), {
        digest: `NEXT_HTTP_ERROR_FALLBACK;${status}`,
      });

    expect(NotFoundBoundaryInner.getDerivedStateFromError(error(404))).toEqual({
      matched: true,
    });
    expect(ForbiddenBoundaryInner.getDerivedStateFromError(error(403))).toEqual({
      matched: true,
    });
    expect(UnauthorizedBoundaryInner.getDerivedStateFromError(error(401))).toEqual({
      matched: true,
    });
    expect(() => NotFoundBoundaryInner.getDerivedStateFromError(error(403))).toThrow();
  });
});
