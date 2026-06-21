import type { ComponentType, ReactNode } from "react";
import "styled-jsx";

declare module "styled-jsx" {
  export type StyleRegistryInstance = StyledJsxStyleRegistry;
  export const style: ComponentType<{
    id: string;
    dynamic?: string;
    children?: ReactNode;
  }>;
}
