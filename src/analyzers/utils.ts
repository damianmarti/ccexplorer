/**
 * Shared utilities for analyzers.
 */

import type { InlineImage } from "../types.js";

function isBase64Block(
  value: object
): value is { type: string; source: { media_type?: string; data?: string } } {
  const block = value as { type?: unknown; source?: unknown };
  if (block.type !== "image" && block.type !== "document") return false;
  const source = block.source as { type?: unknown; data?: unknown } | undefined;
  return source?.type === "base64" && typeof source.data === "string";
}

/** Recursively coerce mixed tool-result content into a display string. */
export function toDisplayText(value: unknown): string {
  return extractContentParts(value).text;
}

/**
 * Recursively coerce mixed message/tool-result content into display text
 * plus any embedded base64 images. Image and document blocks become short
 * placeholders in the text instead of stringified base64 payloads.
 */
export function extractContentParts(value: unknown): {
  text: string;
  images: InlineImage[];
} {
  const images: InlineImage[] = [];
  const text = collectText(value, images);
  return { text, images };
}

function collectText(value: unknown, images: InlineImage[]): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) {
    return value
      .map((entry) => collectText(entry, images))
      .filter((part) => part.length > 0)
      .join(" ");
  }
  if (typeof value === "object") {
    if (isBase64Block(value)) {
      const mediaType = value.source.media_type ?? "unknown";
      const data = value.source.data ?? "";
      if (value.type === "image") {
        images.push({ mediaType, data });
        return `[image: ${mediaType}]`;
      }
      const sizeKb = Math.round((data.length * 3) / 4 / 1024);
      return `[document: ${mediaType} (${sizeKb} KB)]`;
    }
    if (
      "text" in value &&
      typeof (value as { text?: unknown }).text === "string"
    ) {
      return (value as { text: string }).text;
    }
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/**
 * Deep-copy a tool result metadata object, truncating very long string values
 * (embedded base64 payloads, giant stdout). Keeps API payloads small; the
 * detail panel only ever shows a few hundred chars per leaf anyway.
 */
export function sanitizeMetadata(value: unknown, maxStringLength = 10_000): unknown {
  if (typeof value === "string") {
    return value.length > maxStringLength
      ? `${value.slice(0, maxStringLength)}… [truncated ${value.length - maxStringLength} chars]`
      : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeMetadata(entry, maxStringLength));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = sanitizeMetadata(entry, maxStringLength);
    }
    return out;
  }
  return value;
}

/** Truncate a string to `max` characters, appending "..." if trimmed. */
export function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max) + "...";
}

/** Derive a scope identifier from an event's sidechain / agent fields. */
export function getScopeId(event: { isSidechain: boolean; agentId?: string }): string {
  return event.isSidechain ? (event.agentId ?? "unknown") : "main";
}
