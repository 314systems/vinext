import React from "react";
import { makeThenableParams } from "./thenable-params.js";

export type Metadata = {
  title?: string | { default?: string; template?: string; absolute?: string };
  description?: string;
  [key: string]: unknown;
};

export type MetadataMergeEntry = {
  contributesTitle?: boolean;
  isPage?: boolean;
  metadata: Metadata;
};

export type Viewport = {
  width?: string | number;
  height?: string | number;
  initialScale?: number;
  minimumScale?: number;
  maximumScale?: number;
  userScalable?: boolean;
  themeColor?: string | Array<{ media?: string; color: string }>;
  colorScheme?: string;
};

export async function resolveModuleMetadata(
  mod: Record<string, unknown>,
  params: Record<string, string | string[]> = {},
  searchParams?: Record<string, string | string[]>,
  parent: Promise<Metadata> = Promise.resolve({}),
): Promise<Metadata | null> {
  if (typeof mod.generateMetadata === "function") {
    const asyncParams = makeThenableParams(params);
    const props =
      searchParams === undefined
        ? { params: asyncParams }
        : { params: asyncParams, searchParams: makeThenableParams(searchParams) };
    return await (mod.generateMetadata.length >= 2
      ? mod.generateMetadata(props, parent)
      : mod.generateMetadata(props));
  }
  return mod.metadata && typeof mod.metadata === "object" ? (mod.metadata as Metadata) : null;
}

export async function resolveModuleViewport(
  mod: Record<string, unknown>,
  params: Record<string, string | string[]>,
): Promise<Viewport | null> {
  if (typeof mod.generateViewport === "function") {
    return await mod.generateViewport({ params: makeThenableParams(params) });
  }
  return mod.viewport && typeof mod.viewport === "object" ? (mod.viewport as Viewport) : null;
}

function resolveTitle(title: Metadata["title"], template: string | undefined): string | undefined {
  if (typeof title === "string") return template ? template.replace(/%s/g, title) : title;
  if (!title || typeof title !== "object") return undefined;
  if (title.absolute) return title.absolute;
  if (title.default === undefined) return undefined;
  return template ? template.replace(/%s/g, title.default) : title.default;
}

export function mergeMetadataEntries(entries: readonly MetadataMergeEntry[]): Metadata {
  const merged: Metadata = {};
  let parentTemplate: string | undefined;

  for (const entry of entries) {
    const metadata = entry.metadata;
    if (metadata.description !== undefined) merged.description = metadata.description;
    if (entry.contributesTitle !== false && metadata.title !== undefined) {
      merged.title = resolveTitle(metadata.title, parentTemplate);
    }
    if (
      entry.contributesTitle !== false &&
      !entry.isPage &&
      typeof metadata.title === "object" &&
      metadata.title?.template
    ) {
      parentTemplate = metadata.title.template;
    }
  }
  return merged;
}

export function postProcessMetadata(metadata: Metadata): Metadata {
  return metadata;
}

export function mergeMetadata(metadata: Metadata[]): Metadata {
  return mergeMetadataEntries(
    metadata.map((entry, index) => ({
      isPage: index === metadata.length - 1,
      metadata: entry,
    })),
  );
}

export const DEFAULT_VIEWPORT: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export function mergeViewport(viewports: Viewport[]): Viewport {
  return Object.assign({}, DEFAULT_VIEWPORT, ...viewports);
}

export function ViewportHead({ viewport }: { viewport: Viewport }) {
  const elements: React.ReactElement[] = [];
  let key = 0;
  const parts: string[] = [];
  if (viewport.width !== undefined) parts.push(`width=${viewport.width}`);
  if (viewport.height !== undefined) parts.push(`height=${viewport.height}`);
  if (viewport.initialScale !== undefined) parts.push(`initial-scale=${viewport.initialScale}`);
  if (viewport.minimumScale !== undefined) parts.push(`minimum-scale=${viewport.minimumScale}`);
  if (viewport.maximumScale !== undefined) parts.push(`maximum-scale=${viewport.maximumScale}`);
  if (viewport.userScalable !== undefined) {
    parts.push(`user-scalable=${viewport.userScalable ? "yes" : "no"}`);
  }
  if (parts.length > 0) {
    elements.push(<meta key={key++} name="viewport" content={parts.join(", ")} />);
  }
  if (viewport.themeColor) {
    const colors =
      typeof viewport.themeColor === "string"
        ? [{ color: viewport.themeColor }]
        : viewport.themeColor;
    for (const entry of colors) {
      elements.push(
        <meta
          key={key++}
          name="theme-color"
          content={entry.color}
          {...(entry.media ? { media: entry.media } : {})}
        />,
      );
    }
  }
  if (viewport.colorScheme) {
    elements.push(<meta key={key++} name="color-scheme" content={viewport.colorScheme} />);
  }
  return <>{elements}</>;
}

function metadataTitle(metadata: Metadata): string | undefined {
  return typeof metadata.title === "string"
    ? metadata.title
    : metadata.title?.absolute || metadata.title?.default;
}

type MetadataHeadProps = {
  metadata: Metadata;
  pathname?: string;
  trailingSlash?: boolean;
};

export function MetadataHead({ metadata }: MetadataHeadProps) {
  const title = metadataTitle(metadata);
  return (
    <>
      {title ? <title>{title}</title> : null}
      {metadata.description ? <meta name="description" content={metadata.description} /> : null}
    </>
  );
}

function escapeHtmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtmlText(value).replaceAll('"', "&quot;");
}

export function renderMetadataToHtml(metadata: Metadata): string {
  const title = metadataTitle(metadata);
  return (
    (title ? `<title>${escapeHtmlText(title)}</title>` : "") +
    (metadata.description
      ? `<meta name="description" content="${escapeHtmlAttribute(metadata.description)}">`
      : "")
  );
}
