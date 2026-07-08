"use client";

/**
 * next/script shim
 *
 * Provides the <Script> component for loading third-party scripts with
 * configurable loading strategies.
 *
 * Strategies:
 *   - "beforeInteractive": rendered as a <script> tag in SSR output
 *   - "afterInteractive" (default): loaded client-side after hydration
 *   - "lazyOnload": deferred until window.load + requestIdleCallback
 *   - "worker": sets type="text/partytown" (requires Partytown setup)
 */
import React, { useEffect, useRef } from "react";
import * as ReactDOM from "react-dom";
import { hasAppNavigationRuntimeBootstrap } from "../client/navigation-runtime.js";
import { fnv1a64 } from "../utils/hash.js";
import { escapeInlineContent } from "./head.js";
import { useDocumentScriptRegister } from "./document-script-context.js";
import { useScriptNonce } from "./script-nonce-context.js";
import {
  useBeforeInteractiveRegister,
  type BeforeInteractiveInlineScript,
} from "./before-interactive-context.js";
import {
  loadClientScript,
  loadedScripts,
  resolveScriptNonce,
  type ScriptProps,
} from "./script-loader.js";

export { handleClientScriptLoad, initScriptLoader, type ScriptProps } from "./script-loader.js";

/**
 * Insert `<link rel="stylesheet">` tags into `document.head` for each entry
 * in `stylesheets`. Used by the imperative client-side load path
 * (`handleClientScriptLoad`) when `ReactDOM.preinit` is not available
 * (e.g. pre-Float React or hosts that strip it). Mirrors Next.js's
 * `insertStylesheets` Pages-Router fallback at
 * `.nextjs-ref/packages/next/src/client/script.tsx:48-59`.
 *
 * The `ReactDOM.preinit` path is preferred where available — it dedupes
 * across mounts and respects React Float's hoisting order. This DOM
 * fallback is best-effort: no dedupe, no ordering guarantee.
 */
function insertClientStylesheets(stylesheets: string[] | undefined): void {
  if (!stylesheets || stylesheets.length === 0) return;
  if (typeof document === "undefined") return;

  // Prefer ReactDOM.preinit when available — it dedupes via React Float
  // and matches Next.js's app-router behaviour.
  if (typeof ReactDOM.preinit === "function") {
    for (const href of stylesheets) {
      ReactDOM.preinit(href, { as: "style" });
    }
    return;
  }

  const head = document.head;
  if (!head) return;
  for (const href of stylesheets) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.type = "text/css";
    link.href = href;
    head.appendChild(link);
  }
}

/**
 * Emit `<link rel="stylesheet">` tags during SSR for each entry in
 * `stylesheets` via `ReactDOM.preinit`. React Float hoists these into
 * `<head>` in the streamed HTML. Mirrors the App-Router branch of
 * Next.js's Script component at `.nextjs-ref/packages/next/src/client/script.tsx:309-313`.
 */
function preinitStylesheetsForSSR(stylesheets: string[] | undefined): void {
  if (!stylesheets || stylesheets.length === 0) return;
  if (typeof ReactDOM.preinit !== "function") return;
  for (const href of stylesheets) {
    ReactDOM.preinit(href, { as: "style" });
  }
}

function buildBeforeInteractiveScriptProps(options: {
  src?: string;
  id?: string;
  rest: Record<string, unknown>;
  resolvedNonce?: string;
  dangerouslySetInnerHTML?: { __html: string };
  scriptKey: string;
}): Record<string, unknown> {
  const scriptProps: Record<string, unknown> = {
    ...options.rest,
    "data-nscript": "beforeInteractive",
    "data-vinext-script-key": options.scriptKey,
  };
  if (options.src) scriptProps.src = options.src;
  if (options.id) scriptProps.id = options.id;
  if (options.resolvedNonce) {
    scriptProps.nonce = options.resolvedNonce;
  }
  if (options.dangerouslySetInnerHTML) {
    scriptProps.dangerouslySetInnerHTML = {
      __html: escapeInlineContent(options.dangerouslySetInnerHTML.__html, "script"),
    };
  }
  return scriptProps;
}

/**
 * Extract the inline script content for a `beforeInteractive` Script element
 * with no `src`. Returns `null` when the element has neither a string-shaped
 * `children` value nor a valid `dangerouslySetInnerHTML.__html` payload — in
 * that case the caller should fall through to React's regular rendering path.
 *
 * The returned string is the raw author-supplied JavaScript content. Callers
 * are responsible for passing it through `escapeInlineContent(..., "script")`
 * before emitting it inside a `<script>` tag (we keep that escape adjacent
 * to the emit point so the rule is obvious at the boundary).
 */
function extractBeforeInteractiveInlineContent(
  children: React.ReactNode,
  dangerouslySetInnerHTML?: { __html: string },
): string | null {
  if (
    dangerouslySetInnerHTML &&
    typeof dangerouslySetInnerHTML.__html === "string" &&
    dangerouslySetInnerHTML.__html.length > 0
  ) {
    return dangerouslySetInnerHTML.__html;
  }
  if (typeof children === "string" && children.length > 0) {
    return children;
  }
  if (Array.isArray(children) && children.every((c) => typeof c === "string")) {
    const joined = (children as string[]).join("");
    return joined.length > 0 ? joined : null;
  }
  return null;
}

function createScriptKey(options: {
  id?: string;
  src?: string;
  inlineContent: string | null;
}): string {
  if (options.id) return `id:${options.id}`;
  if (options.src) return `src:${options.src}`;
  return `inline:${fnv1a64(options.inlineContent ?? "")}`;
}

function hasHoistedBeforeInteractiveScript(options: { scriptKey: string }): boolean {
  if (typeof document === "undefined" || typeof document.querySelectorAll !== "function") {
    return false;
  }

  const scripts = document.querySelectorAll('script[data-nscript="beforeInteractive"]');
  for (const script of scripts) {
    if (script.getAttribute("data-vinext-script-key") === options.scriptKey) return true;
  }
  return false;
}

/**
 * Map of React DOM prop names to their HTML attribute equivalents. Mirrors
 * Next.js's `set-attributes-from-props.ts`:
 *   .nextjs-ref/packages/next/src/client/set-attributes-from-props.ts
 * HTML parses attribute names case-insensitively, so without this translation
 * `className="foo"` round-trips as `classname="foo"` and CSS selectors on
 * `.foo` never match. Same hazard for `htmlFor`/`for`, `httpEquiv`/`http-equiv`,
 * `acceptCharset`/`accept-charset`.
 */
const REACT_TO_HTML_ATTR: Record<string, string> = {
  acceptCharset: "accept-charset",
  className: "class",
  crossOrigin: "crossorigin",
  htmlFor: "for",
  httpEquiv: "http-equiv",
  referrerPolicy: "referrerpolicy",
};

/**
 * Convert the residual `<Script>` props into a plain string-attributes record
 * for emission inside a hoisted `<script>` tag. Drops React-only props
 * (event handlers, children, etc.) and reserved keys already handled by the
 * pre-head-injection emitter (id, nonce). Skips `undefined`/`null` so they
 * round-trip as "attribute absent" rather than `attr="undefined"`.
 *
 * React DOM prop names (className, htmlFor, etc.) are translated to their
 * HTML attribute names so the output parses correctly — see comment on
 * `REACT_TO_HTML_ATTR`.
 */
function collectBeforeInteractiveAttributes(
  rest: Record<string, unknown>,
): Record<string, string | boolean> {
  const RESERVED = new Set([
    "id",
    "nonce",
    "src",
    "children",
    "strategy",
    "dangerouslySetInnerHTML",
    "onLoad",
    "onReady",
    "onError",
    "stylesheets",
  ]);
  const out: Record<string, string | boolean> = {};
  for (const [key, value] of Object.entries(rest)) {
    if (RESERVED.has(key)) continue;
    if (value === undefined || value === null || value === false) continue;
    const attrName = REACT_TO_HTML_ATTR[key] ?? key;
    if (typeof value === "boolean") {
      out[attrName] = true;
      continue;
    }
    if (typeof value === "string" || typeof value === "number") {
      out[attrName] = String(value);
      continue;
    }
    // Skip anything else (functions, objects) — they cannot serialise into an
    // HTML attribute and only the developer-controlled string/boolean shape
    // is expected for native `<script>` attributes here.
  }
  return out;
}

Object.defineProperty(Script, "__nextScript", { value: true });

function Script(props: ScriptProps): React.ReactElement | null {
  const {
    src,
    id,
    strategy = "afterInteractive",
    onLoad,
    onReady,
    onError,
    children,
    dangerouslySetInnerHTML,
    stylesheets,
    ...rest
  } = props;

  const hasMounted = useRef(false);
  const key = id ?? src ?? "";
  const contextualNonce = useScriptNonce();
  const resolvedNonce = resolveScriptNonce(rest.nonce, contextualNonce);
  // Available only during SSR — the provider lives in app-ssr-entry.ts. When
  // missing (Pages Router SSR, raw renderToString, client render) we keep the
  // inline `<script>` element in source order.
  const registerBeforeInteractive = useBeforeInteractiveRegister();
  const registerDocumentScript = useDocumentScriptRegister();
  const inlineContent = src
    ? null
    : extractBeforeInteractiveInlineContent(children, dangerouslySetInnerHTML);
  const scriptKey = createScriptKey({ id, src, inlineContent });

  // Client path: load scripts via useEffect based on strategy.
  // useEffect never runs during SSR, so it's safe to call unconditionally.
  useEffect(() => {
    if (hasMounted.current) return;
    hasMounted.current = true;

    if (strategy === "beforeInteractive") {
      // The script itself is loaded by Next.js's bootstrap before hydration,
      // but the associated stylesheets still need to land in <head> on the
      // client. ReactDOM.preinit (called inside insertClientStylesheets)
      // dedupes against any SSR-emitted <link rel="stylesheet">, so this is
      // safe even when the server already hoisted them via React Float.
      insertClientStylesheets(stylesheets);
      return;
    }

    // Already loaded — just fire onReady
    if (key && loadedScripts.has(key)) {
      // Stylesheets must still be inserted on subsequent mounts of the same
      // script. loadClientScript handles this for the fresh-load path; the
      // already-loaded shortcut needs it explicitly.
      insertClientStylesheets(stylesheets);
      onReady?.();
      return;
    }

    const load = () => {
      if (key && loadedScripts.has(key)) {
        onReady?.();
        return;
      }

      loadClientScript(
        {
          src,
          id,
          strategy,
          onLoad,
          onReady,
          onError,
          children,
          dangerouslySetInnerHTML,
          stylesheets,
          ...rest,
        },
        {
          resolvedNonce,
          fireReadyWhenAlreadyLoaded: true,
          insertStylesheets: insertClientStylesheets,
        },
      );
    };

    if (strategy === "lazyOnload") {
      // Wait for window load, then use idle callback
      if (document.readyState === "complete") {
        if (typeof requestIdleCallback === "function") {
          requestIdleCallback(load);
        } else {
          setTimeout(load, 1);
        }
      } else {
        window.addEventListener("load", () => {
          if (typeof requestIdleCallback === "function") {
            requestIdleCallback(load);
          } else {
            setTimeout(load, 1);
          }
        });
      }
    } else {
      // "afterInteractive" (default), "beforeInteractive" (client re-mount), "worker"
      load();
    }
  }, [
    src,
    id,
    strategy,
    onLoad,
    onReady,
    onError,
    children,
    dangerouslySetInnerHTML,
    stylesheets,
    key,
    resolvedNonce,
    rest,
  ]);

  // SSR path: only "beforeInteractive" renders a <script> tag server-side
  if (typeof window === "undefined") {
    // Emit associated stylesheets as <link rel="stylesheet"> via React Float.
    // ReactDOM.preinit dedupes across mounts and hoists the link into <head>
    // regardless of strategy — matches Next.js's app-router branch at
    // `.nextjs-ref/packages/next/src/client/script.tsx:309-313`.
    preinitStylesheetsForSSR(stylesheets);

    // React Float preload — emits <link rel="preload" as="script" /> in <head>
    // so the script is fetched while HTML streams. Mirrors Next.js's App Router
    // behavior at .nextjs-ref/packages/next/src/client/script.tsx:298-376:
    //   - afterInteractive with src: preload only (no <script> tag in SSR)
    //   - beforeInteractive with src: preload + <script> tag
    //   - inline scripts (no src): no preload
    // Calling ReactDOM.preload during SSR is safe in both routers; React only
    // hoists the link when it has a real <head> to hoist into.
    if (
      src &&
      typeof ReactDOM.preload === "function" &&
      (strategy === "afterInteractive" || strategy === "beforeInteractive")
    ) {
      const integrity = typeof rest.integrity === "string" ? rest.integrity : undefined;
      const crossOrigin =
        rest.crossOrigin === "anonymous" || rest.crossOrigin === "use-credentials"
          ? rest.crossOrigin
          : undefined;
      const preloadOptions: ReactDOM.PreloadOptions = {
        as: "script",
        crossOrigin,
      };
      if (resolvedNonce !== undefined) {
        preloadOptions.nonce = resolvedNonce;
      }
      if (integrity !== undefined) {
        preloadOptions.integrity = integrity;
      }
      ReactDOM.preload(src, preloadOptions);
    }

    if (registerDocumentScript) {
      if (strategy === "beforeInteractive" || strategy === "beforePageRender") {
        registerDocumentScript({
          kind: "beforeInteractive",
          script: {
            key: scriptKey,
            id,
            src: src ?? undefined,
            innerHTML:
              inlineContent !== null ? escapeInlineContent(inlineContent, "script") : undefined,
            nonce: resolvedNonce,
            attributes: collectBeforeInteractiveAttributes(rest),
          },
        });
      } else {
        registerDocumentScript({
          kind: "client",
          script: { ...props, strategy, nonce: resolvedNonce },
        });
      }
      return null;
    }

    if (strategy === "beforeInteractive" || strategy === "beforePageRender") {
      // beforeInteractive scripts need to run BEFORE any stylesheets,
      // modulepreload links, or other resource hints React Float hoists into
      // <head>. React Fizz emits user-rendered head children AFTER the hoisted
      // resources, so leaving the script in source order breaks the no-flash
      // dark-mode pattern. We instead capture the script through
      // BeforeInteractiveContext and the SSR pipeline emits it immediately
      // after `<head>` opens — guaranteeing it precedes every React-emitted
      // hint in the streamed HTML.
      //
      // Both inline (children/dangerouslySetInnerHTML) and external (src)
      // scripts are registered, mirroring Next.js which routes inline and src
      // beforeInteractive scripts equally through the App Router runtime
      // (.nextjs-ref/packages/next/src/client/script.tsx — the `(self.__next_s=
      // ...).push([0|src, …])` branch).
      if ((src || inlineContent !== null) && registerBeforeInteractive) {
        const registered: BeforeInteractiveInlineScript = {
          key: scriptKey,
          id,
          src: src ?? undefined,
          // Escape `</script>` sequences exactly as the inline render path does
          // (see buildBeforeInteractiveScriptProps); keep the escape colocated
          // with the emit boundary so it never gets accidentally skipped. src
          // scripts have no inline body.
          innerHTML:
            inlineContent !== null ? escapeInlineContent(inlineContent, "script") : undefined,
          nonce: resolvedNonce,
          attributes: collectBeforeInteractiveAttributes(rest),
        };
        registerBeforeInteractive(registered);
        return null;
      }

      return React.createElement(
        "script",
        buildBeforeInteractiveScriptProps({
          src,
          id,
          rest,
          resolvedNonce,
          dangerouslySetInnerHTML,
          scriptKey,
        }),
        children,
      );
    }
    // Other strategies don't render during SSR
    return null;
  }

  if (strategy === "beforeInteractive" || strategy === "beforePageRender") {
    // On the client, suppress the `<script>` render for any beforeInteractive
    // Script in App Router pages — inline AND external `src`. The pre-head
    // splice in app-ssr-entry/app-ssr-stream already put the tag in the DOM
    // (the SSR registration condition above mirrors this exactly), so rendering
    // it again would duplicate the script (double execution) or cause a
    // hydration mismatch (positions differ).
    //
    // For Pages Router and any other SSR path that didn't run through
    // app-ssr-entry, the server rendered the `<script>` inline in source
    // order, so the client must match. We detect "App Router" via the
    // navigation runtime that the App Router bootstrap installs before
    // calling hydrateRoot — it is the most reliable runtime signal we
    // can read from inside a `"use client"` shim.
    if (
      (src || inlineContent !== null) &&
      (hasHoistedBeforeInteractiveScript({ scriptKey }) || hasAppNavigationRuntimeBootstrap())
    ) {
      return null;
    }

    return React.createElement(
      "script",
      buildBeforeInteractiveScriptProps({
        src,
        id,
        rest,
        resolvedNonce,
        dangerouslySetInnerHTML,
        scriptKey,
      }),
      children,
    );
  }

  // The component itself renders nothing — scripts are injected imperatively
  return null;
}

export default Script;
