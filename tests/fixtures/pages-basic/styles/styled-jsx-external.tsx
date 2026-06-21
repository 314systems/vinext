import css from "styled-jsx/css";

export const externalElementStyles = css`
  .external-element {
    background: yellow;
  }
`;

export const externalStyles = css.resolve`
  .external {
    color: hotpink;
  }
`;
