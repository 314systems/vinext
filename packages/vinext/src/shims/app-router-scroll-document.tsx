"use client";

import type { ReactNode } from "react";

/**
 * Full-document navigation lets the browser own scroll and focus restoration.
 * These wrappers only preserve the route tree shape expected by App Router.
 */
export function AppRouterScrollTarget({ children }: { children: ReactNode }) {
  return children;
}

export function AppRouterScrollCommitProvider({
  children,
}: {
  children?: ReactNode;
  commitId: number | null;
}) {
  return children ?? null;
}
