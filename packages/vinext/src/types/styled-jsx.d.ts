declare module "styled-jsx" {
  import type { ComponentType, ReactNode } from "react";

  export type StyleRegistryInstance = {
    styles(options?: { nonce?: string }): ReactNode[];
    flush(): void;
  };

  export const StyleRegistry: ComponentType<{
    registry: StyleRegistryInstance;
    children?: ReactNode;
  }>;
  export function createStyleRegistry(): StyleRegistryInstance;
  export const style: ComponentType<{
    id: string;
    dynamic?: string;
    children?: ReactNode;
  }>;
}

declare module "styled-jsx/babel" {
  const plugin: unknown;
  export default plugin;
}

declare module "@babel/core" {
  export function transformAsync(
    code: string,
    options: Record<string, unknown>,
  ): Promise<{ code?: string | null; map?: unknown } | null>;
}
