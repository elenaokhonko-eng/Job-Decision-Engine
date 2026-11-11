const TRACKING_PARAMETER = /^(?:utm_.+|trk|ref|source|gh_src|lever-source|campaign|medium|trackingid)$/i;

/**
 * A stored employer value that is a URL, image/logo path or HTML fragment
 * rather than a name, e.g. a LinkedIn logo URL tail
 * `logo_100_100/company-logo_100_100/0/1631425624819/x_logo?e=...` or
 * `...?e=1&t=x" alt="Ex`. Domain-style names such as "Booking.com" are names.
 */
function looksLikeUrlOrMarkup(value: string): boolean {
  // Every quantifier is bounded, so each pattern is linear in the (already capped) input.
  return /[a-z][a-z0-9+.-]{0,30}:\/\//i.test(value)
    || /^(?:\/\/|www\.)/i.test(value)
    || /[<>]/.test(value)
    || /\b[a-z][a-z-]{0,30}\s{0,5}=\s{0,5}["']/i.test(value)
    || /[?&][a-z][\w-]{0,30}=/i.test(value)
    || /(?:company-logo|logo_\d{1,5}_\d{1,5}|\.(?:png|jpe?g|gif|svg|webp)(?:[?#"']|$))/i.test(value)
    // A whitespace-free token with two or more "/" is a path, not a name.
    || /(?:^|\s)[^\s/]{0,200}\/[^\s/]{0,200}\//.test(value);
}

/**
 * Longer than any employer name. Values over it are never names, and the
 * pattern checks only ever see bounded input (email alt text is untrusted).
 */
export const MAX_EMPLOYER_NAME_CHARS = 200;

/**
 * Whether a discovery card's employer value names no employer: empty, the
 * legacy "Unknown" / "Unknown Company" placeholders, or a value that is a URL,
 * logo path or HTML fragment (legacy Gmail cards stored LinkedIn logo URLs as
 * the employer). Identity checks treat such a card as "employer unknown" and
 * match on the title alone; a real employer name still has to match.
 */
export function isUnknownEmployerName(value: string | null | undefined): boolean {
  const trimmed = (value ?? "").trim();
  if (trimmed.length > MAX_EMPLOYER_NAME_CHARS) return true;
  const key = trimmed.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!key || key === "unknown" || key === "unknown company") return true;
  return looksLikeUrlOrMarkup(trimmed);
}

export function normalizePostingUrl(value: string, sourceName?: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const source = (sourceName ?? "").toLowerCase();
    const hostname = url.hostname.toLowerCase();
    if (source === "linkedin" || hostname === "linkedin.com" || hostname.endsWith(".linkedin.com")) {
      const linkedInId = url.pathname.match(/\/(?:comm\/)?jobs\/view\/(\d+)(?:\/|$)/i)?.[1];
      if (linkedInId) return `linkedin-job:${linkedInId}`;
    }
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMETER.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    const path = url.pathname.replace(/\/+$/, "") || "/";
    return `${url.hostname.toLowerCase()}${path}${url.search}`;
  } catch {
    return null;
  }
}

export function stableSourcePostingIdentity(
  sourceName: string,
  sourceExternalId: string | null,
  canonicalUrl: string | null,
): string | null {
  const source = sourceName.trim().toLowerCase();
  const external = sourceExternalId?.trim() ?? "";
  if (external) {
    if (source === "linkedin" && /^\d+$/.test(external)) return `${source}:linkedin-job:${external}`;
    const normalizedUrl = normalizePostingUrl(external, sourceName);
    if (normalizedUrl) return `${source}:${normalizedUrl}`;
    return `${source}:${external}`;
  }
  const normalizedUrl = canonicalUrl ? normalizePostingUrl(canonicalUrl, sourceName) : null;
  return normalizedUrl ? `${source}:${normalizedUrl}` : null;
}
