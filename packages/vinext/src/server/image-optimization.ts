/**
 * Image optimization request handler.
 *
 * Handles `/_next/image?url=...&w=...&q=...` requests. In production
 * on Cloudflare Workers, uses the Images binding (`env.IMAGES`) to
 * resize and transcode on the fly. On other runtimes (Node.js dev/prod
 * server), serves the original file as a passthrough with appropriate
 * Cache-Control headers.
 *
 * Format negotiation: inspects the `Accept` header and serves AVIF, WebP,
 * or JPEG depending on client support.
 *
 * Security: All image responses include Content-Security-Policy and
 * X-Content-Type-Options headers to prevent XSS via SVG or Content-Type
 * spoofing. SVG content is blocked by default (following Next.js behavior).
 * When `dangerouslyAllowSVG` is enabled in next.config.js, SVGs are served
 * as-is (no transformation) with security headers applied.
 */

import { badRequestResponse } from "./http-error-responses.js";
import { stripBasePath } from "../utils/base-path.js";

/** The pathname that triggers image optimization (matches Next.js). */
export const IMAGE_OPTIMIZATION_PATH = "/_next/image";

/**
 * Vinext-prefixed alias for the image optimization endpoint. Accepted
 * alongside IMAGE_OPTIMIZATION_PATH so apps that wire image URLs to the
 * vinext-prefixed path continue to work; emit IMAGE_OPTIMIZATION_PATH
 * for any newly generated URLs.
 */
export const VINEXT_IMAGE_OPTIMIZATION_PATH = "/_vinext/image";

/**
 * Returns true when `pathname` is either supported image optimization
 * endpoint.
 *
 * A single trailing slash is accepted (`/_next/image/`): with
 * `trailingSlash: true`, Next.js 308-redirects `/_next/image?url=...` to
 * `/_next/image/?url=...` and then serves the slashed form — its route
 * matching strips a trailing slash before matching internal paths (see
 * getItem in packages/next/src/server/lib/router-utils/filesystem.ts).
 * Rejecting the slashed form 404'd every dev-mode next/image request under
 * `trailingSlash: true`.
 */
export function isImageOptimizationPath(pathname: string): boolean {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    pathname = pathname.slice(0, -1);
  }
  return pathname === IMAGE_OPTIMIZATION_PATH || pathname === VINEXT_IMAGE_OPTIMIZATION_PATH;
}

/**
 * Image security configuration from next.config.js `images` section.
 * Controls SVG handling and security headers for the image endpoint.
 */
export type ImageConfig = {
  /** Allowed device widths. Defaults to Next.js device sizes. */
  deviceSizes?: number[];
  /** Allowed fixed-image widths. Defaults to Next.js image sizes. */
  imageSizes?: number[];
  /**
   * Allowed output qualities. When unset, any quality from 1-100 is permitted
   * (matches Next.js: an unset `images.qualities` is not restricted to a single
   * value). When set, only the listed qualities are accepted.
   */
  qualities?: number[];
  /** Allow SVG through the image optimization endpoint. Default: false. */
  dangerouslyAllowSVG?: boolean;
  /**
   * Allow image optimization for hostnames that resolve to private IP addresses.
   * Default: false.
   *
   * Note: This field is currently reserved for future server-side remote-image
   * fetching. vinext's image optimization endpoint only serves local files, so
   * there is no active server-side SSRF vector — the flag is consumed client-side
   * via the image shim instead.
   */
  dangerouslyAllowLocalIP?: boolean;
  /** Maximum source response body size. Defaults to 50 MB. */
  maximumResponseBody?: number;
  /** Minimum optimized image cache lifetime in seconds. Defaults to 4 hours. */
  minimumCacheTTL?: number;
  /** Content-Disposition header value. Default: "inline". */
  contentDispositionType?: "inline" | "attachment";
  /** Content-Security-Policy header value. Default: "script-src 'none'; frame-src 'none'; sandbox;" */
  contentSecurityPolicy?: string;
};

/**
 * Next.js default device sizes and image sizes.
 * These are the allowed widths for image optimization when no custom
 * config is provided. Matches Next.js defaults exactly.
 */
export const DEFAULT_DEVICE_SIZES = [640, 750, 828, 1080, 1200, 1920, 2048, 3840];
export const DEFAULT_IMAGE_SIZES = [16, 32, 48, 64, 96, 128, 256, 384];
const DEV_BLUR_MAX_WIDTH = 8;
const DEV_BLUR_QUALITY = 70;

export type ParseImageParamsOptions = {
  isDev?: boolean;
};

export function resolveDevImageRedirect(
  requestUrl: URL,
  allowedWidths: number[] = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES],
  allowedQualities?: number[],
  options: ParseImageParamsOptions = { isDev: true },
): string | null {
  const params = parseImageParams(requestUrl, allowedWidths, allowedQualities, options);
  if (!params) return null;
  if (
    params.imageUrl.startsWith("/@") ||
    params.imageUrl.startsWith("/__vite") ||
    params.imageUrl.startsWith("/node_modules")
  ) {
    return null;
  }
  const resolved = new URL(params.imageUrl, requestUrl.origin);
  if (resolved.origin !== requestUrl.origin) return null;
  return resolved.pathname + resolved.search;
}

/**
 * Parse and validate image optimization query parameters.
 * Returns null if the request is malformed.
 *
 * Ported from Next.js:
 * test/integration/image-optimizer/test/index.test.ts
 * https://github.com/vercel/next.js/blob/canary/test/integration/image-optimizer/test/index.test.ts
 */
export function parseImageParams(
  url: URL,
  allowedWidths: number[] = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES],
  allowedQualities?: number[],
  options: ParseImageParamsOptions = {},
): { imageUrl: string; width: number; quality: number } | null {
  // Intentional hardening divergence from Next.js: reject duplicate and unknown
  // parameters so semantically identical transforms cannot occupy distinct
  // cache keys and amplify image transformation work.
  const allowedParamNames = new Set(["url", "w", "q", "dpl"]);
  for (const name of url.searchParams.keys()) {
    if (!allowedParamNames.has(name) || url.searchParams.getAll(name).length !== 1) return null;
  }

  const imageUrl = url.searchParams.get("url");
  if (!imageUrl) return null;
  if (imageUrl.length > 3072) return null;

  const widthParam = url.searchParams.get("w");
  const qualityParam = url.searchParams.get("q");
  if (!widthParam || !/^[0-9]+$/.test(widthParam)) return null;
  if (!qualityParam || !/^[0-9]+$/.test(qualityParam)) return null;

  const width = Number.parseInt(widthParam, 10);
  const quality = Number.parseInt(qualityParam, 10);
  if (String(width) !== widthParam || String(quality) !== qualityParam) return null;

  const isDevBlurWidth = options.isDev && width <= DEV_BLUR_MAX_WIDTH;
  const isDevBlurQuality = options.isDev && quality === DEV_BLUR_QUALITY;
  if (width <= 0 || (!allowedWidths.includes(width) && !isDevBlurWidth)) return null;
  if (quality < 1 || quality > 100) return null;
  // Only enforce the quality allowlist when `images.qualities` is configured.
  // Matches Next.js: an unset `qualities` permits any quality from 1-100.
  if (allowedQualities && !allowedQualities.includes(quality) && !isDevBlurQuality) {
    return null;
  }

  // Prevent open redirect / SSRF — only allow path-relative URLs.
  // Normalize backslashes to forward slashes first: browsers and the URL
  // constructor treat /\evil.com as protocol-relative (//evil.com).
  const normalizedUrl = imageUrl.replaceAll("\\", "/");
  // The URL must start with "/" (but not "//") to be a valid relative path.
  // This blocks absolute URLs (http://, https://), protocol-relative (//),
  // backslash variants (/\), and exotic schemes (data:, javascript:, ftp:, etc.).
  if (!normalizedUrl.startsWith("/") || normalizedUrl.startsWith("//")) {
    return null;
  }
  // Double-check: after URL construction, the origin must not change.
  // This catches any remaining parser differentials.
  try {
    const base = "https://localhost";
    const resolved = new URL(normalizedUrl, base);
    if (resolved.origin !== base) {
      return null;
    }
    // Next rejects any local source whose decoded pathname contains the image
    // optimizer endpoint as a complete path segment. This covers basePath and
    // nested suffix forms such as `/docs/_next/image/again`, not just an exact
    // `/_next/image` source.
    const decodedPathname = decodeURIComponent(resolved.pathname).replaceAll("\\", "/");
    if (/\/(?:_next|_vinext)\/image(?:$|\/)/.test(decodedPathname)) return null;
  } catch {
    return null;
  }

  return { imageUrl: normalizedUrl, width, quality };
}

/**
 * Negotiate the best output format based on the Accept header.
 * Returns an IANA media type.
 */
export function negotiateImageFormat(acceptHeader: string | null): string {
  if (!acceptHeader) return "image/jpeg";
  if (acceptHeader.includes("image/avif")) return "image/avif";
  if (acceptHeader.includes("image/webp")) return "image/webp";
  return "image/jpeg";
}

/**
 * Content-Security-Policy for image optimization responses.
 * Blocks script execution and framing to prevent XSS via SVG or other
 * active content that might be served through the image endpoint.
 * Matches Next.js default: script-src 'none'; frame-src 'none'; sandbox;
 */
export const IMAGE_CONTENT_SECURITY_POLICY = "script-src 'none'; frame-src 'none'; sandbox;";

/**
 * Allowlist of Content-Types that are safe to serve from the image endpoint.
 * SVG is intentionally excluded — it can contain embedded JavaScript and is
 * essentially an XML document, not a safe raster image format.
 */
const SAFE_IMAGE_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/jp2",
  "image/jxl",
  "image/x-icon",
  "image/x-icns",
  "image/vnd.microsoft.icon",
  "image/bmp",
  "image/tiff",
]);

/**
 * Check if a Content-Type header value is a safe image type.
 * Returns false for SVG (unless dangerouslyAllowSVG is true), HTML, or any non-image type.
 */
export function isSafeImageContentType(
  contentType: string | null,
  dangerouslyAllowSVG = false,
): boolean {
  if (!contentType) return false;
  // Extract the media type, ignoring parameters (e.g., charset)
  const mediaType = contentType.split(";")[0].trim().toLowerCase();
  if (SAFE_IMAGE_CONTENT_TYPES.has(mediaType)) return true;
  if (dangerouslyAllowSVG && mediaType === "image/svg+xml") return true;
  return false;
}

async function readImageSource(
  response: Response,
  maximumResponseBody: number,
): Promise<
  | { bytes: Uint8Array; response: Response; contentType: string | null; tooLarge: false }
  | { tooLarge: true }
  | null
> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalSize = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalSize += value.byteLength;
    if (totalSize > maximumResponseBody) {
      await reader.cancel();
      return { tooLarge: true };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const startsWith = (...signature: number[]) =>
    bytes.length >= signature.length && signature.every((byte, index) => bytes[index] === byte);
  const textPrefix = new TextDecoder()
    .decode(bytes.subarray(0, 256))
    .replace(/^\uFEFF/, "")
    .trimStart()
    .toLowerCase();
  let contentType: string | null = null;
  if (startsWith(0xff, 0xd8, 0xff)) contentType = "image/jpeg";
  else if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) contentType = "image/png";
  else if (startsWith(0x47, 0x49, 0x46, 0x38)) contentType = "image/gif";
  if (
    startsWith(0x52, 0x49, 0x46, 0x46) &&
    bytes.length >= 12 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    contentType = "image/webp";
  else if (startsWith(0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a))
    contentType = "image/jxl";
  else if (startsWith(0xff, 0x0a)) contentType = "image/jxl";
  else if (startsWith(0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a))
    contentType = "image/jp2";
  else if (
    bytes.length >= 12 &&
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  ) {
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    if (brand === "avif" || brand === "avis") contentType = "image/avif";
  } else if (startsWith(0x00, 0x00, 0x01, 0x00)) contentType = "image/x-icon";
  else if (startsWith(0x69, 0x63, 0x6e, 0x73)) contentType = "image/x-icns";
  else if (startsWith(0x42, 0x4d)) contentType = "image/bmp";
  else if (startsWith(0x49, 0x49, 0x2a, 0x00) || startsWith(0x4d, 0x4d, 0x00, 0x2a))
    contentType = "image/tiff";
  else if (textPrefix.startsWith("<?xml") || textPrefix.startsWith("<svg"))
    contentType = "image/svg+xml";

  const headers = new Headers(response.headers);
  headers.set("ETag", await extractImageEtag(headers.get("ETag"), bytes));
  headers.set("Content-Length", String(bytes.byteLength));

  return {
    bytes,
    response: new Response(bytes, {
      status: response.status,
      statusText: response.statusText,
      headers,
    }),
    contentType,
    tooLarge: false,
  };
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function getImageEtag(bytes: Uint8Array): Promise<string> {
  const buffer = new Uint8Array(bytes).buffer;
  return toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", buffer)));
}

async function extractImageEtag(etag: string | null, bytes: Uint8Array): Promise<string> {
  return etag ? toBase64Url(new TextEncoder().encode(etag)) : getImageEtag(bytes);
}

function isFreshImageRequest(request: Request, etag: string): boolean {
  if (request.headers.get("Cache-Control")?.toLowerCase().includes("no-cache")) return false;
  const ifNoneMatch = request.headers.get("If-None-Match");
  if (!ifNoneMatch) return false;
  const normalize = (value: string) => value.trim().replace(/^W\//, "");
  return ifNoneMatch
    .split(",")
    .some((value) => value.trim() === "*" || normalize(value) === normalize(etag));
}

const IMAGE_EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/jp2": "jp2",
  "image/jxl": "jxl",
  "image/x-icon": "ico",
  "image/x-icns": "icns",
  "image/vnd.microsoft.icon": "ico",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "image/svg+xml": "svg",
};

function getImageFilename(imageUrl: string, contentType: string | null): string {
  let pathname = imageUrl.split("?", 1)[0];
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    // Keep the encoded pathname. It is still safe after the normalization below.
  }
  const sourceBasename = pathname.split("/").pop() || "image";
  const sourceStem = sourceBasename.split(".", 1)[0] || "image";
  const sanitizedStem = Array.from(sourceStem.normalize("NFC"), (character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint < 0x20 || codePoint === 0x7f || character === "/" || character === "\\"
      ? "_"
      : character;
  })
    .join("")
    .slice(0, 200);
  const mediaType = contentType?.split(";", 1)[0].trim().toLowerCase();
  const extension = (mediaType && IMAGE_EXTENSION_BY_CONTENT_TYPE[mediaType]) || "bin";
  return `${sanitizedStem || "image"}.${extension}`;
}

function imageContentDisposition(
  imageUrl: string,
  contentType: string | null,
  dispositionType: "inline" | "attachment",
): string {
  const filename = getImageFilename(imageUrl, contentType);
  const fallback = filename
    .replace(/[^\x20-\x7e]/g, "?")
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"');
  const encoded = encodeURIComponent(filename).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  const extended = /[^\x20-\x7e]/.test(filename) ? `; filename*=UTF-8''${encoded}` : "";
  return `${dispositionType}; filename="${fallback}"${extended}`;
}

/**
 * Apply security headers to an image optimization response.
 * These headers are set on every response from the image endpoint,
 * regardless of whether the image was transformed or served as-is.
 * When an ImageConfig is provided, uses its values for CSP and Content-Disposition.
 */
function setImageSecurityHeaders(
  headers: Headers,
  imageUrl: string,
  contentType: string | null,
  config?: ImageConfig,
): void {
  headers.set(
    "Content-Security-Policy",
    config?.contentSecurityPolicy ?? IMAGE_CONTENT_SECURITY_POLICY,
  );
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set(
    "Content-Disposition",
    imageContentDisposition(
      imageUrl,
      contentType,
      config?.contentDispositionType === "attachment" ? "attachment" : "inline",
    ),
  );
}

function createPassthroughImageResponse(
  source: Response,
  config?: ImageConfig,
  request?: Request,
  detectedContentType?: string,
  cacheControl?: string,
  imageUrl = "/image",
): Response {
  const headers = new Headers();
  const contentType = detectedContentType ?? source.headers.get("Content-Type");
  const etag = source.headers.get("ETag");
  if (etag) headers.set("ETag", etag);
  headers.set("Cache-Control", cacheControl ?? imageCacheControl(source, config));
  headers.set("Vary", "Accept");
  if (etag && request && isFreshImageRequest(request, etag)) {
    return new Response(null, { status: 304, headers });
  }
  if (contentType) headers.set("Content-Type", contentType);
  const contentLength = source.headers.get("Content-Length");
  if (contentLength) headers.set("Content-Length", contentLength);
  setImageSecurityHeaders(headers, imageUrl, contentType, config);
  return new Response(request?.method === "HEAD" ? null : source.body, { status: 200, headers });
}

function imageCacheControl(source: Response, config?: ImageConfig): string {
  const directives = new Map(
    (source.headers.get("Cache-Control") ?? "")
      .split(",")
      .map((directive) => directive.trim().split("=", 2))
      .map(([key, value]) => [key.toLowerCase(), value]),
  );
  let upstreamMaxAge = directives.get("s-maxage") || directives.get("max-age") || "";
  if (upstreamMaxAge.startsWith('"') && upstreamMaxAge.endsWith('"')) {
    upstreamMaxAge = upstreamMaxAge.slice(1, -1);
  }
  const parsedMaxAge = Number.parseInt(upstreamMaxAge, 10);
  const maxAge = Math.max(
    config?.minimumCacheTTL ?? 14_400,
    Number.isNaN(parsedMaxAge) ? 0 : parsedMaxAge,
  );
  return `public, max-age=${maxAge}, must-revalidate`;
}

/**
 * Handlers for image optimization I/O operations.
 * Workers provide these callbacks to adapt their specific bindings.
 */
export type ImageHandlers = {
  /** Fetch the source image from storage (e.g., Cloudflare ASSETS binding). */
  fetchAsset: (path: string, request: Request) => Promise<Response>;
  /** Optional: Transform the image (resize, format, quality). */
  transformImage?: (
    body: ReadableStream,
    options: { width: number; format: string; quality: number },
  ) => Promise<Response>;
};

/**
 * Build the request used to resolve a local image source through the app's
 * normal request pipeline. This uses a credential-free synthetic request,
 * preserving the optimizer request method except that HEAD is resolved as GET,
 * matching Next.js and preventing external rewrites from forwarding caller credentials.
 */
export function createInternalImageRequest(
  imageUrl: string,
  request: Request,
  basePath = "",
): Request | null {
  const sourceUrl = new URL(imageUrl, request.url);
  let sourcePathname: string;
  try {
    sourcePathname = decodeURIComponent(sourceUrl.pathname);
  } catch {
    return null;
  }
  const normalizedPathname = sourcePathname.replaceAll("\\", "/");
  const withoutBasePath = stripBasePath(normalizedPathname, basePath);
  if (/\/(?:_next|_vinext)\/image(?:$|\/)/.test(withoutBasePath)) return null;
  return new Request(sourceUrl, {
    method: !request.method || request.method === "HEAD" ? "GET" : request.method,
  });
}

/**
 * Handle image optimization requests.
 *
 * Parses and validates the request, fetches the source image via the provided
 * handlers, optionally transforms it, and returns the response with appropriate
 * cache headers.
 */
export async function handleImageOptimization(
  request: Request,
  handlers: ImageHandlers,
  allowedWidths?: number[],
  imageConfig?: ImageConfig,
): Promise<Response> {
  const url = new URL(request.url);
  const params = parseImageParams(url, allowedWidths, imageConfig?.qualities);

  if (!params) {
    return badRequestResponse();
  }

  const { imageUrl, width, quality } = params;

  // Fetch source image
  const sourceResult = await readImageSource(
    await handlers.fetchAsset(imageUrl, request),
    imageConfig?.maximumResponseBody ?? 50_000_000,
  );
  if (sourceResult?.tooLarge) {
    return new Response("The requested resource is too large.", { status: 413 });
  }
  if (!sourceResult) {
    return new Response("The requested resource isn't a valid image.", { status: 400 });
  }
  const { bytes: sourceBytes, response: source, contentType: sourceContentType } = sourceResult;
  const sourceIsStatic = /\/(?:static\/media|_next\/static\/immutable\/media)(?:$|\/)/.test(
    new URL(imageUrl, request.url).pathname,
  );
  if (!sourceContentType) {
    return new Response("The requested resource isn't a valid image.", { status: 400 });
  }

  // Negotiate output format from Accept header
  const format = negotiateImageFormat(request.headers.get("Accept"));

  // Block unsafe detected types (e.g., SVG which can contain embedded scripts).
  // SVG is only allowed when dangerouslyAllowSVG is explicitly enabled.
  if (!isSafeImageContentType(sourceContentType, imageConfig?.dangerouslyAllowSVG)) {
    return new Response("The requested resource is not an allowed image type", { status: 400 });
  }

  // SVG passthrough: SVG is a vector format, so transformation (resize, format
  // conversion) provides no benefit. Serve as-is with security headers.
  // This matches Next.js behavior where SVG is a "bypass type".
  if (sourceContentType === "image/svg+xml") {
    return createPassthroughImageResponse(
      source,
      imageConfig,
      request,
      sourceContentType,
      undefined,
      imageUrl,
    );
  }

  // Transform if handler provided, otherwise serve original
  let transformFailed = false;
  if (handlers.transformImage) {
    try {
      const transformed = await handlers.transformImage(source.body!, {
        width,
        format,
        quality,
      });
      if (!transformed.ok || !transformed.body) {
        throw new Error(`Image transform returned ${transformed.status}`);
      }
      const transformedBytes = new Uint8Array(await transformed.arrayBuffer());
      const headers = new Headers();
      const transformedContentType = transformed.headers.get("Content-Type");
      const transformedEtag = await getImageEtag(transformedBytes);
      if (transformedContentType) headers.set("Content-Type", transformedContentType);
      headers.set("ETag", transformedEtag);
      headers.set(
        "Cache-Control",
        sourceIsStatic
          ? "public, max-age=315360000, immutable"
          : imageCacheControl(source, imageConfig),
      );
      headers.set("Vary", "Accept");
      // Verify the transformed response also has a safe Content-Type.
      // A malicious or buggy transform handler could return HTML.
      if (!isSafeImageContentType(headers.get("Content-Type"), imageConfig?.dangerouslyAllowSVG)) {
        headers.set("Content-Type", format);
      }

      if (isFreshImageRequest(request, transformedEtag)) {
        headers.delete("Content-Type");
        return new Response(null, { status: 304, headers });
      }

      headers.set("Content-Length", String(transformedBytes.byteLength));
      setImageSecurityHeaders(headers, imageUrl, headers.get("Content-Type"), imageConfig);
      return new Response(request.method === "HEAD" ? null : transformedBytes, {
        status: 200,
        headers,
      });
    } catch (e) {
      console.error("[vinext] Image optimization error:", e);
      transformFailed = true;
    }
  }

  // Fallback: serve original image with cache headers
  const fallbackSource = new Response(sourceBytes.slice().buffer, {
    status: source.status,
    statusText: source.statusText,
    headers: source.headers,
  });
  return createPassthroughImageResponse(
    fallbackSource,
    imageConfig,
    request,
    sourceContentType,
    sourceIsStatic
      ? "public, max-age=315360000, immutable"
      : transformFailed
        ? `public, max-age=${imageConfig?.minimumCacheTTL ?? 14_400}, must-revalidate`
        : undefined,
    imageUrl,
  );
}

// ---------------------------------------------------------------------------
// Configured image optimizer registry.
//
// The image optimizer is the pluggable transform backend (e.g. Cloudflare
// Images via `env.IMAGES`). It is configured declaratively through the
// `images` option on the `vinext()` plugin — see `image/image-adapters-virtual.ts`
// — and registered on the first request by the generated
// `virtual:vinext-image-adapters` module, which imports `setImageOptimizer`
// from here.
//
// The active optimizer is stored on `globalThis` via `Symbol.for` so a single
// registration is visible across the separate RSC and SSR Vite environments
// (they load distinct module instances), mirroring the data-cache handler
// resolution in `shims/cache.ts`. When no optimizer is registered (no adapter
// configured, or the adapter factory threw on a runtime without the required
// binding — e.g. Node.js / dev), image requests fall back to serving the
// original asset unoptimized.
// ---------------------------------------------------------------------------

/**
 * A server-side image optimizer: the transform backend that resizes/transcodes
 * a source image. Produced by an adapter factory (e.g. `imagesOptimizer()` from
 * `@vinext/cloudflare/images/images-optimizer`) and registered via
 * {@link setImageOptimizer}.
 */
export type ImageOptimizer = {
  /** Transform the source image (resize, format, quality). */
  transformImage: (
    body: ReadableStream,
    options: { width: number; format: string; quality: number },
  ) => Promise<Response>;
};

const _IMAGE_OPTIMIZER_KEY = Symbol.for("vinext.imageOptimizer");
const _gImageOptimizer = globalThis as unknown as Record<PropertyKey, ImageOptimizer | undefined>;

/**
 * Register the active image optimizer (transform backend). An explicit
 * registration always wins; passing `null` clears it (falling back to
 * unoptimized passthrough).
 *
 * Configure this declaratively via the `images.optimizer` option on the
 * `vinext()` plugin in your `vite.config.ts` rather than calling it directly.
 * On Cloudflare Workers:
 *
 * ```ts
 * import { vinext } from "vinext";
 * import { imagesOptimizer } from "@vinext/cloudflare/images/images-optimizer";
 *
 * export default defineConfig({
 *   plugins: [vinext({ images: { optimizer: imagesOptimizer() } })],
 * });
 * ```
 *
 * The plugin registers the optimizer across every runtime/router entry, so you
 * don't have to wire `env.IMAGES` into a custom worker entry. This setter
 * remains the internal registration target.
 */
export function setImageOptimizer(optimizer: ImageOptimizer | null): void {
  _gImageOptimizer[_IMAGE_OPTIMIZER_KEY] = optimizer ?? undefined;
}

/** Get the active image optimizer, or `null` when none is configured. */
export function getImageOptimizer(): ImageOptimizer | null {
  return _gImageOptimizer[_IMAGE_OPTIMIZER_KEY] ?? null;
}

/**
 * Handle an image optimization request using the configured optimizer (if any).
 *
 * This is the single entry point every runtime/router seam (App Router worker,
 * Pages worker, Node prod server) should call: it reads the registered
 * {@link ImageOptimizer} and wires its `transformImage` into
 * {@link handleImageOptimization}, with the caller supplying the runtime's
 * `fetchAsset` (e.g. the Cloudflare `ASSETS` binding, or filesystem reads on
 * Node). When no optimizer is registered, the request is served unoptimized
 * (passthrough) with the same security/cache headers.
 */
export function handleConfiguredImageOptimization(
  request: Request,
  fetchAsset: (path: string, request: Request) => Promise<Response>,
  allowedWidths?: number[],
  imageConfig?: ImageConfig,
): Promise<Response> {
  const optimizer = getImageOptimizer();
  return handleImageOptimization(
    request,
    {
      fetchAsset,
      // Wrap rather than detach the method so an optimizer implemented as a
      // class instance keeps its `this` binding.
      transformImage: optimizer
        ? (body, options) => optimizer.transformImage(body, options)
        : undefined,
    },
    allowedWidths,
    imageConfig,
  );
}
