"use client";

import React from "react";
import { decodeRedirectError, isRedirectError } from "./navigation-errors.js";
import { assertSafeNavigationUrl } from "./url-safety.js";
import { isNavigationSignalError } from "../utils/navigation-signal.js";

type ErrorFallback = React.ComponentType<{ error: unknown; reset: () => void }>;
type ErrorBoundaryProps = {
  fallback: ErrorFallback;
  children: React.ReactNode;
  resetKey?: string | null;
};
type CapturedError = { thrownValue: unknown };

export class ErrorBoundaryInner extends React.Component<
  ErrorBoundaryProps & { isImplicitRootErrorBoundary?: boolean },
  { error: CapturedError | null }
> {
  state: { error: CapturedError | null } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    if (isNavigationSignalError(error)) throw error;
    return { error: { thrownValue: error } };
  }

  reset = () => this.setState({ error: null });

  render() {
    if (!this.state.error) return this.props.children;
    const Fallback = this.props.fallback;
    return <Fallback error={this.state.error.thrownValue} reset={this.reset} />;
  }
}

export function ErrorBoundary(props: ErrorBoundaryProps) {
  return <ErrorBoundaryInner {...props} />;
}

export function GlobalErrorBoundary({
  fallback,
  children,
}: {
  fallback: ErrorFallback;
  children: React.ReactNode;
}) {
  return (
    <ErrorBoundaryInner fallback={fallback} isImplicitRootErrorBoundary>
      {children}
    </ErrorBoundaryInner>
  );
}

export class RedirectErrorBoundary extends React.Component<
  { children?: React.ReactNode },
  { redirect: string | null; type: "push" | "replace" }
> {
  state: { redirect: string | null; type: "push" | "replace" } = {
    redirect: null,
    type: "replace",
  };

  static getDerivedStateFromError(error: unknown) {
    if (!isRedirectError(error)) throw error;
    const redirect = decodeRedirectError(error.digest);
    if (!redirect) throw error;
    return { redirect: redirect.url, type: redirect.type };
  }

  componentDidMount() {
    this.navigate();
  }

  componentDidUpdate() {
    this.navigate();
  }

  navigate() {
    const { redirect, type } = this.state;
    if (redirect === null) return;
    assertSafeNavigationUrl(redirect);
    if (type === "push") {
      window.location.assign(redirect);
    } else {
      window.location.replace(redirect);
    }
  }

  render() {
    return this.state.redirect === null ? this.props.children : null;
  }
}

export function RedirectBoundary({ children }: { children?: React.ReactNode }) {
  return <RedirectErrorBoundary>{children}</RedirectErrorBoundary>;
}

type AccessBoundaryProps = {
  fallback: React.ReactNode;
  children: React.ReactNode;
  resetKey?: string | null;
};

function accessBoundary(status: 401 | 403 | 404) {
  return class extends React.Component<AccessBoundaryProps, { matched: boolean }> {
    state = { matched: false };

    static getDerivedStateFromError(error: unknown) {
      if (error && typeof error === "object" && "digest" in error) {
        const digest = String(error.digest);
        if (
          (status === 404 && digest === "NEXT_NOT_FOUND") ||
          digest === `NEXT_HTTP_ERROR_FALLBACK;${status}`
        ) {
          return { matched: true };
        }
      }
      throw error;
    }

    render() {
      if (!this.state.matched) return this.props.children;
      return (
        <>
          <meta name="robots" content="noindex" />
          {this.props.fallback}
        </>
      );
    }
  };
}

export const NotFoundBoundaryInner = accessBoundary(404);
export const ForbiddenBoundaryInner = accessBoundary(403);
export const UnauthorizedBoundaryInner = accessBoundary(401);

export function NotFoundBoundary(props: AccessBoundaryProps) {
  return <NotFoundBoundaryInner {...props} />;
}

export function ForbiddenBoundary(props: AccessBoundaryProps) {
  return <ForbiddenBoundaryInner {...props} />;
}

export function UnauthorizedBoundary(props: AccessBoundaryProps) {
  return <UnauthorizedBoundaryInner {...props} />;
}
