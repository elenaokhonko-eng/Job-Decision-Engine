const HTML_ENTITY_MAP: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: "\"",
  apos: "'",
  "#39": "'",
};

const SCRIPT_BLOCK_PATTERN = /<script\b[^>]*>[\s\S]*?<\/script\b[^>]*>/gi;
const STYLE_BLOCK_PATTERN = /<style\b[^>]*>[\s\S]*?<\/style\b[^>]*>/gi;

function decodeNumericEntity(code: string): string {
  const normalized = code.toLowerCase();
  const isHex = normalized.startsWith("#x");
  const numberPart = normalized.startsWith("#") ? normalized.slice(isHex ? 2 : 1) : "";
  const value = numberPart ? Number.parseInt(numberPart, isHex ? 16 : 10) : Number.NaN;
  if (!Number.isFinite(value) || value < 0) {
    return "";
  }
  try {
    return String.fromCodePoint(value);
  } catch {
    return "";
  }
}

export function decodeHtmlEntities(input: string): string {
  return input.replace(/&([a-zA-Z0-9#x]+);/g, (match, key: string) => {
    const mapped = HTML_ENTITY_MAP[key.toLowerCase()];
    if (mapped !== undefined) {
      return mapped;
    }
    if (key.startsWith("#")) {
      const decoded = decodeNumericEntity(key);
      return decoded || "";
    }
    return match;
  });
}

export function escapeHtml(input: unknown): string {
  const text = String(input ?? "");
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function normalizeWhitespace(input: string): string {
  return input.replace(/\r\n/g, "\n").replace(/[ \t\f\v]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Convert HTML-ish content into readable plain text.
 * - Strips script/style blocks
 * - Converts common block tags into newlines
 * - Drops remaining tags
 * - Decodes common HTML entities
 */
export function stripHtmlToText(input: unknown): string {
  const raw = String(input ?? "");
  if (!raw) {
    return "";
  }

  const withoutScripts = raw
    .replace(SCRIPT_BLOCK_PATTERN, " ")
    .replace(STYLE_BLOCK_PATTERN, " ");

  const withBreaks = withoutScripts
    .replace(/<br\b[^>]*>/gi, "\n")
    .replace(/<\/(p|div|section|article|header|footer|ul|ol|li|h1|h2|h3|h4|h5|h6)\b[^>]*>/gi, "\n")
    .replace(/<(p|div|section|article|header|footer|ul|ol|li|h1|h2|h3|h4|h5|h6)\b[^>]*>/gi, "\n");

  const withoutTags = withBreaks.replace(/<[^>]+>/g, " ");
  const decoded = decodeHtmlEntities(withoutTags);
  return normalizeWhitespace(decoded.replace(/\s+\n/g, "\n").replace(/\n\s+/g, "\n"));
}

