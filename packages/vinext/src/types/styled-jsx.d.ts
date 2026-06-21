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
  export function useStyleRegistry(): StyleRegistryInstance;
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

declare module "styled-jsx/css" {
  import type { ReactElement } from "react";

  type ResolvedStyle = {
    className: string;
    styles: ReactElement;
  };

  type CssTag = {
    (strings: TemplateStringsArray, ...values: unknown[]): string;
    global(strings: TemplateStringsArray, ...values: unknown[]): string;
    resolve(strings: TemplateStringsArray, ...values: unknown[]): ResolvedStyle;
  };

  const css: CssTag;
  export default css;
}

declare module "@babel/core" {
  export function transformAsync(
    code: string,
    options: Record<string, unknown>,
  ): Promise<{ code?: string | null; map?: unknown } | null>;
}
