import { sha256Hex, stableStringify } from '../config/structuredLoader.js';
import { stableSourcePostingIdentity } from './postingIdentity.js';
import {
  PostingDateDerivationSchema,
  approximateFreshnessBasis,
  type ApproximateDateUnit,
} from '../contracts/postingFacts.js';

export interface ExtractedFreshnessEvidence {
  readonly sourcePublishedAt: string | null;
  readonly repostedAt: string | null;
  readonly sourceUpdatedAt: string | null;
  readonly sourceExpiresAt: string | null;
  /** POSTED_AT / REPOSTED_AT, or e.g. POSTED_AT_APPROXIMATE_WEEK for a date converted from relative text. */
  readonly freshnessBasis: string | null;
  /** Unit of the chosen date's approximation, when it was converted from relative source text. */
  readonly approximateUnit: ApproximateDateUnit | null;
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

interface ParsedDate {
  readonly iso: string;
  readonly raw: string | number;
}

function parseSourceDate(value: unknown): ParsedDate | null {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? { iso: value.toISOString(), raw: value.toISOString() } : null;
  }
  if (typeof value === 'number' || (typeof value === 'string' && /^\d{9,13}$/.test(value.trim()))) {
    const numeric = typeof value === 'number' ? value : Number(value);
    const digits = String(Math.trunc(Math.abs(numeric))).length;
    const multiplier = digits === 10 ? 1000 : digits === 13 ? 1 : null;
    if (multiplier === null) return null;
    const date = new Date(numeric * multiplier);
    return Number.isFinite(date.getTime()) ? { iso: date.toISOString(), raw: numeric } : null;
  }
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? { iso: date.toISOString(), raw: value } : null;
}

interface FoundDate {
  readonly iso: string;
  /** Set when the record's date_derivations say this value was converted from relative text. */
  readonly approximateUnit: ApproximateDateUnit | null;
}

function approximateUnitFor(record: Record<string, unknown>, key: string): ApproximateDateUnit | null {
  const derivations = asRecord(record.date_derivations);
  const parsed = PostingDateDerivationSchema.safeParse(derivations?.[key]);
  if (!parsed.success || parsed.data.basis !== 'RELATIVE_SOURCE_TEXT') return null;
  return parsed.data.precision === 'EXACT' ? null : parsed.data.precision;
}

function findDate(
  records: readonly Record<string, unknown>[],
  keys: readonly string[],
): FoundDate | null {
  for (const record of records) {
    for (const key of keys) {
      const parsed = parseSourceDate(record[key]);
      if (parsed) return { iso: parsed.iso, approximateUnit: approximateUnitFor(record, key) };
    }
  }
  return null;
}

function firstDate(
  records: readonly Record<string, unknown>[],
  keys: readonly string[],
): string | null {
  return findDate(records, keys)?.iso ?? null;
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
  const published = findDate(records, [
    'posted_at', 'date_posted', 'datePosted', 'published_at', 'publishedAt',
    'publication_date', 'pubDate', 'date_created', 'dateCreated',
  ]);
  const reposted = findDate(records, [
    'reposted_at', 'date_reposted', 'repost_date', 'repostedAt',
  ]);
  const sourcePublishedAt = published?.iso ?? null;
  const repostedAt = reposted?.iso ?? null;
  const sourceUpdatedAt = firstDate(records, [
    'source_updated_at', 'last_modified_at', 'lastModified', 'updated_at', 'updatedAt',
  ]);
  const sourceExpiresAt = firstDate(records, [
    'source_expires_at', 'expires_at', 'expiresAt', 'validThrough', 'valid_through',
    'applicationDeadline', 'application_deadline', 'closingDate', 'close_date',
  ]);
  const chosen = reposted ? { kind: 'REPOSTED_AT' as const, date: reposted } : published ? { kind: 'POSTED_AT' as const, date: published } : null;
  const approximateUnit = chosen?.date.approximateUnit ?? null;
  const freshnessBasis = chosen
    ? approximateUnit ? approximateFreshnessBasis(chosen.kind, approximateUnit) : chosen.kind
    : null;
  const sourceIdentity = stableSourcePostingIdentity(input.sourceName, input.sourceExternalId, input.canonicalUrl);

  return {
    sourcePublishedAt,
    repostedAt,
    sourceUpdatedAt,
    sourceExpiresAt,
    freshnessBasis,
    approximateUnit,
    // A date converted from relative text is an estimate, not an authoritative timestamp.
    freshnessConfidence: freshnessBasis ? approximateUnit ? 50 : 100 : null,
    postingIdentityHash: sourceIdentity
      ? sha256Hex(stableStringify([input.sourceName.trim().toLowerCase(), sourceIdentity]))
      : null,
  };
}
