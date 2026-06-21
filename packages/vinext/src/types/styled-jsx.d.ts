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
  import type { JSX } from "react";

  // oxlint-disable-next-line typescript/no-explicit-any
  function css(chunks: TemplateStringsArray, ...args: any[]): JSX.Element;
  namespace css {
    export function global(
      chunks: TemplateStringsArray,
      // oxlint-disable-next-line typescript/no-explicit-any
      ...args: any[]
    ): JSX.Element;
    export function resolve(
      chunks: TemplateStringsArray,
      // oxlint-disable-next-line typescript/no-explicit-any
      ...args: any[]
    ): { className: string; styles: JSX.Element };
  }
  export = css;
}

declare module "styled-jsx/style" {
  // oxlint-disable-next-line typescript/no-explicit-any
  export default function JSXStyle(props: any): null;
}

declare module "@babel/core" {
  export function transformAsync(
    code: string,
    options: Record<string, unknown>,
  ): Promise<{ code?: string | null; map?: unknown } | null>;
}
