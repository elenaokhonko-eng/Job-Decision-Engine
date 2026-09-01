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
import { ExtractedJob, ExtractedJobSchema, SourceName } from "../../contracts/index.js";

export interface AdapterResult {
  sourceName: SourceName;
  success: boolean;
  jobs: ExtractedJob[];
  totalFetched: number;
  error?: string;
  isRateLimited?: boolean;
  quarantined?: number; // count of items that failed schema validation
}

export abstract class BaseSourceAdapter {
  abstract sourceName: SourceName;

  /** Default per-request timeout: 15 seconds */
  protected timeoutMs: number = 15_000;

  abstract fetchJobs(options?: { limit?: number; page?: number }): Promise<AdapterResult>;

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
    return String(value ?? "")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/\s+/g, " ")
      .trim();
  }
}
