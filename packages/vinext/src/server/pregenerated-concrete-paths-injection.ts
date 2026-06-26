import { escapeRegExp } from "../utils/regex.js";

export const VINEXT_PREGENERATED_CONCRETE_PATHS_START =
  "/* __VINEXT_PREGENERATED_CONCRETE_PATHS_START__ */";
export const VINEXT_PREGENERATED_CONCRETE_PATHS_END =
  "/* __VINEXT_PREGENERATED_CONCRETE_PATHS_END__ */";

const pregeneratedConcretePathsInjectionPattern = new RegExp(
  `${escapeRegExp(VINEXT_PREGENERATED_CONCRETE_PATHS_START)}[\\s\\S]*?${escapeRegExp(VINEXT_PREGENERATED_CONCRETE_PATHS_END)}\\n?`,
  "g",
);

export function stripPregeneratedConcretePathsInjection(code: string): string {
  return code.replace(pregeneratedConcretePathsInjectionPattern, "");
}
