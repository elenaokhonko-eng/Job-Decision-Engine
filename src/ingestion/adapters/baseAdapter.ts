/**
 * BaseSourceAdapter
 *
 * All ATS/job-board adapters extend this class.
 * Provides:
 *  - fetchWithTimeout(): AbortController-based fetch with configurable TTL
 *  - validateJob(): runtime ExtractedJobSchema.safeParse() per item —
 *    invalid records are quarantined with an error log, never silently
 *    passed downstream (AGENTS.md invariant 2)
 */
import { createHash } from "node:crypto";
import { ExtractedJob, ExtractedJobSchema, SourceName } from "../../contracts/index.js";
import { readJsonResponseBounded, readResponseTextBounded } from "../../security/boundedResponse.js";
import { stripHtmlToText } from "../../security/sanitize.js";

export interface QuarantinedSourceCandidate {
  readonly identity: string;
  readonly rawPayload: unknown;
  readonly error: string;
}

export interface AdapterResult {
  sourceName: SourceName;
  success: boolean;
  jobs: ExtractedJob[];
  totalFetched: number;
  snapshotTotal?: number;
  error?: string;
  isRateLimited?: boolean;
  quarantined?: number;
  quarantinedCandidates?: QuarantinedSourceCandidate[];
  nextCursor?: string | null;
  hasMore?: boolean;
  snapshotId?: string | null;
}

export interface AdapterFetchOptions {
  readonly limit?: number;
  readonly page?: number;
  readonly cursor?: string | null;
}

export const MAX_SOURCE_RESPONSE_BYTES = 8 * 1024 * 1024;
export const MAX_SOURCE_RECORDS = 2_000;

export function snapshotPage<T>(
  records: readonly T[],
  limit: number,
  cursor: string | null | undefined,
  page: number | undefined,
  identity: (record: T) => string,
): { records: T[]; nextCursor: string | null; hasMore: boolean } {
  const ordered = [...records].sort((left, right) => identity(left).localeCompare(identity(right)));
  const after = cursor?.startsWith("after:") ? decodeURIComponent(cursor.slice("after:".length)) : null;
  const offset = cursor?.startsWith("offset:") ? Number(cursor.slice("offset:".length)) : Math.max(0, page ?? 0) * limit;
  const eligible = after !== null
    ? ordered.filter((record) => identity(record).localeCompare(after) > 0)
    : ordered.slice(offset);
  const selected = eligible.slice(0, limit);
  const hasMore = eligible.length > selected.length;
  const lastIdentity = selected.length > 0 ? identity(selected[selected.length - 1]) : null;
  return {
    records: selected,
    nextCursor: hasMore && lastIdentity !== null ? `after:${encodeURIComponent(lastIdentity)}` : null,
    hasMore,
  };
}

export function stableAdapterIdentity(value: unknown): string {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    // Provider JSON is narrowed at this external-data boundary.
    const record = value as Record<string, unknown>;
    for (const field of ["source_external_id", "sourceExternalId", "id", "jobId", "slug", "employer_posting_url", "jobUrl", "hostedUrl", "canonical_apply_url", "application_url", "url"]) {
      const identity = record[field];
      if (typeof identity === "string" && identity.trim()) return identity.trim();
      if (typeof identity === "number" && Number.isFinite(identity)) return String(identity);
    }
  }
  // This digest only orders anonymous rows within one snapshot; it is not a canonical posting identity.
  const serialized = JSON.stringify(value ?? null);
  return `snapshot:${createHash("sha256").update(serialized).digest("hex")}`;
}

export abstract class BaseSourceAdapter {
  abstract sourceName: SourceName;
  private quarantinedCandidates: QuarantinedSourceCandidate[] = [];

  /** Default per-request timeout: 15 seconds */
  protected timeoutMs: number = 15_000;

  abstract fetchJobs(options?: AdapterFetchOptions): Promise<AdapterResult>;

  protected beginFetch(): void {
    this.quarantinedCandidates = [];
  }

  protected getQuarantinedCandidates(): QuarantinedSourceCandidate[] {
    return [...this.quarantinedCandidates];
  }

  /**
   * Fetch with an AbortController timeout.
   * Throws on network failure or timeout — callers return an error AdapterResult.
   */
  protected async fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  protected async readResponseText(
    response: Response,
    maxBytes = MAX_SOURCE_RESPONSE_BYTES,
  ): Promise<string> {
    return readResponseTextBounded(response, maxBytes, "Source response");
  }

  protected async readJsonResponse(response: Response): Promise<unknown> {
    return readJsonResponseBounded(response, MAX_SOURCE_RESPONSE_BYTES, "Source response");
  }

  protected assertRecordCount(records: readonly unknown[], maxRecords = MAX_SOURCE_RECORDS): void {
    if (records.length > maxRecords) {
      throw new RangeError(`Source response contains ${records.length} records; limit is ${maxRecords}.`);
    }
  }

  /**
   * Validate a raw item against ExtractedJobSchema.
   * Returns the validated object on success, or null + logs the error.
   * Invalid items are counted as `quarantined` and never passed to the broker.
   */
  protected validateJob(raw: unknown, sourceRef: string): ExtractedJob | null {
    const result = ExtractedJobSchema.safeParse(raw);
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      this.quarantinedCandidates.push({ identity: sourceRef, rawPayload: raw, error: issues });
      console.warn(`⚠️ [${this.sourceName}] Item quarantined (${sourceRef}): ${issues}`);
      return null;
    }
    return result.data;
  }

  /** Helper to build a consistent error result */
  protected errorResult(error: string, opts?: { isRateLimited?: boolean }): AdapterResult {
    return {
      sourceName: this.sourceName,
      success: false,
      jobs: [],
      totalFetched: 0,
      error,
      isRateLimited: opts?.isRateLimited ?? false,
    };
  }

  protected sanitizeHtml(value: unknown): string {
    return stripHtmlToText(value).replace(/\s+/g, " ").trim();
  }
}
