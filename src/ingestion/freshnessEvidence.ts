import { sha256Hex, stableStringify } from '../config/structuredLoader.js';

export interface ExtractedFreshnessEvidence {
  readonly sourcePublishedAt: string | null;
  readonly repostedAt: string | null;
  readonly sourceUpdatedAt: string | null;
  readonly freshnessBasis: 'POSTED_AT' | 'REPOSTED_AT' | null;
  readonly freshnessConfidence: number | null;
  readonly postingIdentityHash: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nestedRecords(payload: Record<string, unknown>): Record<string, unknown>[] {
  const rows = [payload];
  for (const key of ['job', 'data', 'posting', 'result']) {
    const nested = asRecord(payload[key]);
    if (nested) rows.push(nested);
  }
  return rows;
}

function firstDate(
  records: readonly Record<string, unknown>[],
  keys: readonly string[]
): string | null {
  for (const record of records) {
    for (const key of keys) {
      const raw = record[key];
      if (typeof raw !== 'string' && !(raw instanceof Date)) continue;
      const date = raw instanceof Date ? raw : new Date(raw);
      if (Number.isFinite(date.getTime())) return date.toISOString();
    }
  }
  return null;
}

export function extractFreshnessEvidence(input: {
  rawPayload: unknown;
  sourceName: string;
  sourceExternalId: string | null;
  canonicalUrl: string | null;
  contentHash: string;
}): ExtractedFreshnessEvidence {
  const payload = asRecord(input.rawPayload);
  const records = payload ? nestedRecords(payload) : [];
  const sourcePublishedAt = firstDate(records, [
    'posted_at',
    'date_posted',
    'datePosted',
    'published_at',
    'publishedAt',
    'publication_date',
  ]);
  const repostedAt = firstDate(records, [
    'reposted_at',
    'date_reposted',
    'repost_date',
    'repostedAt',
  ]);
  const sourceUpdatedAt = firstDate(records, [
    'source_updated_at',
    'last_modified_at',
    'lastModified',
    'updated_at',
    'updatedAt',
  ]);
  const freshnessBasis = repostedAt ? 'REPOSTED_AT' : sourcePublishedAt ? 'POSTED_AT' : null;
  const identityParts = [
    input.sourceName.trim().toLowerCase(),
    input.sourceExternalId?.trim() || input.canonicalUrl?.trim() || 'no-source-identity',
    sourcePublishedAt,
    repostedAt,
    input.contentHash,
  ];
  const hasAuthoritativeSourceIdentity = Boolean(
    input.sourceExternalId?.trim() || sourcePublishedAt || repostedAt
  );

  return {
    sourcePublishedAt,
    repostedAt,
    sourceUpdatedAt,
    freshnessBasis,
    freshnessConfidence: freshnessBasis ? 100 : null,
    postingIdentityHash: hasAuthoritativeSourceIdentity
      ? sha256Hex(stableStringify(identityParts))
      : null,
  };
}
