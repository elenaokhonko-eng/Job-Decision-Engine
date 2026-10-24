const TRACKING_PARAMETER = /^(?:utm_.+|trk|ref|source|gh_src|lever-source|campaign|medium|trackingid)$/i;

export function normalizePostingUrl(value: string, sourceName?: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const source = (sourceName ?? "").toLowerCase();
    if (source === "linkedin" || url.hostname.toLowerCase().endsWith("linkedin.com")) {
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
