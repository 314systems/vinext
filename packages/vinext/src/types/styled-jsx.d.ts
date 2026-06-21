declare module "styled-jsx" {
  import type { ComponentType, JSX, ReactNode } from "react";

  export type StyledJsxStyleRegistry = {
    styles(options?: { nonce?: string }): JSX.Element[];
    flush(): void;
    // oxlint-disable-next-line typescript/no-explicit-any
    add(props: any): void;
    // oxlint-disable-next-line typescript/no-explicit-any
    remove(props: any): void;
  };

  export type StyleRegistryInstance = StyledJsxStyleRegistry;

  export const StyleRegistry: ComponentType<{
    registry?: StyledJsxStyleRegistry;
    children?: ReactNode;
  }>;
  export function createStyleRegistry(): StyledJsxStyleRegistry;
  export function useStyleRegistry(): StyledJsxStyleRegistry;
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
