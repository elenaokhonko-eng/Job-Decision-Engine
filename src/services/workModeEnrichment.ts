import crypto from "node:crypto";
import pg from "pg";
import { stripHtmlToText } from "../security/sanitize.js";
import { type WorkspaceContext } from "../workspace/context.js";
import { extractHybridAttendance, type HybridAttendanceFacts } from "./criteria.js";

const EXTRACTOR_VERSION = "work_mode_enrichment_v1";
const FETCH_TIMEOUT_MS = 15_000;

export interface WorkModeEnrichmentResult {
  workplace_type: "REMOTE" | "HYBRID" | "ONSITE" | "UNKNOWN";
  office_days_min: number | null;
  office_days_max: number | null;
  attendance_basis: string;
  territory_restriction: string | null;
  work_auth_restriction: string | null;
  evidence_quote: string | null;
  source_type: "STRUCTURED_METADATA" | "CANONICAL_PAGE" | "STORED_DESCRIPTION" | "CACHED";
  status: "ENRICHED" | "FAILED" | "SKIPPED" | "GENUINELY_UNKNOWN";
  fingerprint: string;
}

export function generateEnrichmentFingerprint(
  canonicalUrl: string | null,
  jobVersionId: string,
  extractorVersion = EXTRACTOR_VERSION
): string {
  const normalized = (canonicalUrl || "").trim().toLowerCase();
  return crypto.createHash("sha256").update(`${jobVersionId}:${normalized}:${extractorVersion}`).digest("hex");
}

export const computeEnrichmentFingerprint = (
  jobVersionId: string,
  canonicalUrl: string | null,
  extractorVersion = EXTRACTOR_VERSION
): string => generateEnrichmentFingerprint(canonicalUrl, jobVersionId, extractorVersion);

function safeHttpUrl(value: string | null | undefined): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const hostname = url.hostname.toLowerCase();
    if (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".internal") ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      /^10\./.test(hostname) ||
      /^192\.168\./.test(hostname) ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function isAuthenticatedSource(url: URL): boolean {
  return url.hostname === "linkedin.com" || url.hostname.endsWith(".linkedin.com");
}

export function extractWorkModeFromText(text: string): {
  workplace_type: "REMOTE" | "HYBRID" | "ONSITE" | "UNKNOWN";
  office_days_min: number | null;
  office_days_max: number | null;
  attendance_basis: string;
  evidence_quote: string | null;
} {
  const d = (text || "").toLowerCase();

  // 1. Check explicit on-site presence or office days >= 4
  const officeDaysMatch = d.match(/\b([1-5])\s*days?\s*(?:per\s*week|a\s*week|\/week)?\s*(?:in|at)?\s*(?:the\s*)?office\b/i)
    || d.match(/\b([1-5])\s*days?\s*(?:per\s*week|a\s*week|\/week)?\s*on-?site\b/i);
  const isExplicitOnsite = /\b(100%\s*on-?site|fully\s*on-?site|on-premises\s*only|lab-based|wet\s*lab|clinic-based)\b/i.test(d)
    || /(?:^|[|·•:,])\s*(?:on-?site|onsite)\b/i.test(d)
    || /\b(?:workplace|work\s+model|workplace\s+type|work\s+type)\s*:\s*(?:on-?site|onsite)\b/i.test(d)
    || (officeDaysMatch !== null && Number(officeDaysMatch[1]) >= 4);

  if (isExplicitOnsite) {
    const days = officeDaysMatch ? Number(officeDaysMatch[1]) : 5;
    return {
      workplace_type: "ONSITE",
      office_days_min: days,
      office_days_max: days,
      attendance_basis: "EMPLOYER_STATED",
      evidence_quote: officeDaysMatch?.[0] || "On-site requirement detected",
    };
  }

  // 2. Check hybrid
  if (/\bhybrid\b/i.test(d)) {
    const attendance = extractHybridAttendance(d);
    return {
      workplace_type: "HYBRID",
      office_days_min: attendance?.office_days_min ?? 3,
      office_days_max: attendance?.office_days_max ?? 3,
      attendance_basis: attendance?.basis ?? "POLICY_HYBRID_3_2",
      evidence_quote: attendance?.evidence?.[0] || "Hybrid model specified",
    };
  }

  // 3. Check remote
  const remoteMatch = d.match(/\b(fully\s+remote|100%\s+remote|remote[- ]first|work\s+from\s+home|work\s+remotely|telecommute)\b/i)
    || d.match(/(?:^|[|·•:,])\s*remote\b/i)
    || d.match(/\b(?:workplace|work\s+model|workplace\s+type|work\s+type|location)\s*:\s*remote\b/i);

  if (remoteMatch) {
    return {
      workplace_type: "REMOTE",
      office_days_min: 0,
      office_days_max: 0,
      attendance_basis: "REMOTE",
      evidence_quote: remoteMatch[0].trim(),
    };
  }

  return {
    workplace_type: "UNKNOWN",
    office_days_min: null,
    office_days_max: null,
    attendance_basis: "UNKNOWN",
    evidence_quote: null,
  };
}

export function parseJsonLdWorkMode(html: string): {
  workplace_type: "REMOTE" | "HYBRID" | "ONSITE" | "UNKNOWN";
  territory_restriction: string | null;
  evidence_quote: string | null;
} | null {
  const scripts = html.match(/<script\b[^>]+type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script\b[^>]*>/gi) || [];
  for (const script of scripts) {
    const body = script.replace(/^<script\b[^>]*>/i, "").replace(/<\/script\b[^>]*>$/i, "").trim();
    try {
      const parsed = JSON.parse(body) as unknown;
      const values = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of values) {
        if (!item || typeof item !== "object") continue;
        const record = item as Record<string, unknown>;
        const rawLoc = record.jobLocationType ?? record.workplaceType ?? record.workLocationType;
        const locationType = Array.isArray(rawLoc)
          ? rawLoc.map(String).join(" ").toUpperCase()
          : String(rawLoc || "").toUpperCase();

        if (locationType.includes("TELECOMMUTE") || locationType.includes("REMOTE")) {
          const applicantLoc = record.applicantLocationRequirements
            ? JSON.stringify(record.applicantLocationRequirements)
            : null;
          return {
            workplace_type: "REMOTE",
            territory_restriction: applicantLoc,
            evidence_quote: `JSON-LD jobLocationType: ${locationType}`,
          };
        }
        if (locationType.includes("HYBRID")) {
          return {
            workplace_type: "HYBRID",
            territory_restriction: null,
            evidence_quote: `JSON-LD workplaceType: ${locationType}`,
          };
        }
        if (locationType.includes("ONSITE") || locationType.includes("ON-SITE") || locationType.includes("ON_SITE")) {
          return {
            workplace_type: "ONSITE",
            territory_restriction: null,
            evidence_quote: `JSON-LD workplaceType: ${locationType}`,
          };
        }
      }
    } catch {
      // Ignored
    }
  }
  return null;
}

export function extractWorkModeFromJsonLd(html: string): "REMOTE" | "HYBRID" | "ONSITE" | null {
  const parsed = parseJsonLdWorkMode(html);
  if (!parsed || parsed.workplace_type === "UNKNOWN") return null;
  return parsed.workplace_type;
}

export function extractWorkModeFromHtml(html: string): "REMOTE" | "HYBRID" | "ONSITE" | null {
  const clean = stripHtmlToText(html);
  const textExtracted = extractWorkModeFromText(clean);
  if (textExtracted.workplace_type === "UNKNOWN") return null;
  return textExtracted.workplace_type;
}

export async function fetchCanonicalWorkMode(sourceUrl: string | null): Promise<{
  workplace_type: "REMOTE" | "HYBRID" | "ONSITE" | "UNKNOWN";
  office_days_min: number | null;
  office_days_max: number | null;
  attendance_basis: string;
  territory_restriction: string | null;
  work_auth_restriction: string | null;
  evidence_quote: string | null;
  status: "ENRICHED" | "FAILED" | "SKIPPED" | "GENUINELY_UNKNOWN";
}> {
  const url = safeHttpUrl(sourceUrl);
  if (!url) return {
    workplace_type: "UNKNOWN",
    office_days_min: null,
    office_days_max: null,
    attendance_basis: "UNKNOWN",
    territory_restriction: null,
    work_auth_restriction: null,
    evidence_quote: null,
    status: "SKIPPED"
  };

  if (isAuthenticatedSource(url)) {
    return {
      workplace_type: "UNKNOWN",
      office_days_min: null,
      office_days_max: null,
      attendance_basis: "UNKNOWN",
      territory_restriction: null,
      work_auth_restriction: null,
      evidence_quote: null,
      status: "SKIPPED"
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.1",
        "User-Agent": "JobDecisionEngine/2.2 (work-mode-enricher)",
      },
    });

    if (!response.ok) {
      return {
        workplace_type: "UNKNOWN",
        office_days_min: null,
        office_days_max: null,
        attendance_basis: "UNKNOWN",
        territory_restriction: null,
        work_auth_restriction: null,
        evidence_quote: `HTTP ${response.status}`,
        status: "FAILED"
      };
    }

    const html = await response.text();

    // Check JSON-LD first
    const jsonLd = parseJsonLdWorkMode(html);
    if (jsonLd && jsonLd.workplace_type !== "UNKNOWN") {
      return {
        workplace_type: jsonLd.workplace_type,
        office_days_min: 0,
        office_days_max: 0,
        attendance_basis: "REMOTE",
        territory_restriction: jsonLd.territory_restriction,
        work_auth_restriction: null,
        evidence_quote: jsonLd.evidence_quote,
        status: "ENRICHED",
      };
    }

    // Check text extracted from HTML
    const cleanText = stripHtmlToText(html);
    const textExtraction = extractWorkModeFromText(cleanText);
    if (textExtraction.workplace_type !== "UNKNOWN") {
      return {
        ...textExtraction,
        territory_restriction: null,
        work_auth_restriction: null,
        status: "ENRICHED",
      };
    }

    return {
      workplace_type: "UNKNOWN",
      office_days_min: null,
      office_days_max: null,
      attendance_basis: "UNKNOWN",
      territory_restriction: null,
      work_auth_restriction: null,
      evidence_quote: null,
      status: "GENUINELY_UNKNOWN",
    };
  } catch {
    return {
      workplace_type: "UNKNOWN",
      office_days_min: null,
      office_days_max: null,
      attendance_basis: "UNKNOWN",
      territory_restriction: null,
      work_auth_restriction: null,
      evidence_quote: "Fetch timeout or network error",
      status: "FAILED",
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function enrichWorkModeIfNeeded(
  clientOrPool: pg.Pool | pg.PoolClient,
  context: WorkspaceContext,
  job: {
    canonical_job_id: string;
    job_version_id: string;
    canonical_url?: string | null;
    workplace_type?: string | null;
    location?: string | null;
    description_text?: string | null;
  }
): Promise<WorkModeEnrichmentResult> {
  const currentMode = String(job.workplace_type || "").trim().toUpperCase();
  const fingerprint = generateEnrichmentFingerprint(job.canonical_url ?? null, job.job_version_id);

  // 1. Check existing cached enrichment record for idempotency
  try {
    const { rows: cached } = await clientOrPool.query<{
      workplace_type: "REMOTE" | "HYBRID" | "ONSITE" | "UNKNOWN";
      office_days_min: number | null;
      office_days_max: number | null;
      attendance_basis: string;
      territory_restriction: string | null;
      work_auth_restriction: string | null;
      evidence_quote: string | null;
      source_type: "STRUCTURED_METADATA" | "CANONICAL_PAGE" | "STORED_DESCRIPTION";
      status: "ENRICHED" | "FAILED" | "SKIPPED" | "GENUINELY_UNKNOWN";
    }>(
      `SELECT workplace_type, office_days_min, office_days_max, attendance_basis,
              territory_restriction, work_auth_restriction, evidence_quote, source_type, status
       FROM work_mode_enrichments
       WHERE workspace_id = $1 AND fingerprint = $2
       LIMIT 1`,
      [context.workspaceId, fingerprint]
    );

    if (cached.length > 0) {
      return {
        ...cached[0],
        source_type: "CACHED",
        fingerprint,
      };
    }
  } catch (error: any) {
    console.error("Enrichment cache lookup failed at line 333:", error?.message || error, "code:", error?.code);
    // If migration 058 has not run yet in dynamic test schema, continue without caching
    if (error?.code !== "42P01") throw error;
  }

  // 2. Check stored full description
  if (job.description_text) {
    const fromDesc = extractWorkModeFromText(job.description_text);
    if (fromDesc.workplace_type !== "UNKNOWN") {
      const result: WorkModeEnrichmentResult = {
        ...fromDesc,
        territory_restriction: null,
        work_auth_restriction: null,
        source_type: "STORED_DESCRIPTION",
        status: "ENRICHED",
        fingerprint,
      };
      await persistEnrichmentResult(clientOrPool, context, job, result).catch(() => undefined);
      return result;
    }
  }

  // 3. Check structured metadata in raw_job_observations
  try {
    const { rows: observations } = await clientOrPool.query<{
      workplace_type_raw: string | null;
      location_raw: string | null;
      raw_payload: any;
    }>(
      `SELECT workplace_type_raw, location_raw, raw_payload
       FROM raw_job_observations
       WHERE workspace_id = $1 AND job_version_id = $2
       ORDER BY retrieved_at DESC
       LIMIT 3`,
      [context.workspaceId, job.job_version_id]
    );

    for (const obs of observations) {
      const rawWp = String(obs.workplace_type_raw || "").trim().toUpperCase();
      if (["REMOTE", "HYBRID", "ONSITE"].includes(rawWp)) {
        const result: WorkModeEnrichmentResult = {
          workplace_type: rawWp as any,
          office_days_min: rawWp === "REMOTE" ? 0 : rawWp === "HYBRID" ? 3 : 5,
          office_days_max: rawWp === "REMOTE" ? 0 : rawWp === "HYBRID" ? 3 : 5,
          attendance_basis: rawWp === "REMOTE" ? "REMOTE" : rawWp === "HYBRID" ? "POLICY_HYBRID_3_2" : "EMPLOYER_STATED",
          territory_restriction: null,
          work_auth_restriction: null,
          evidence_quote: `Observation workplace_type_raw: ${obs.workplace_type_raw}`,
          source_type: "STRUCTURED_METADATA",
          status: "ENRICHED",
          fingerprint,
        };
        await persistEnrichmentResult(clientOrPool, context, job, result).catch(() => undefined);
        return result;
      }

      if (obs.raw_payload && typeof obs.raw_payload === "object") {
        const p = obs.raw_payload as Record<string, unknown>;
        const payloadWp = String(p.workplaceType || p.workplace_type || p.workMode || p.work_mode || "").trim().toUpperCase();
        if (["REMOTE", "HYBRID", "ONSITE"].includes(payloadWp)) {
          const result: WorkModeEnrichmentResult = {
            workplace_type: payloadWp as any,
            office_days_min: payloadWp === "REMOTE" ? 0 : payloadWp === "HYBRID" ? 3 : 5,
            office_days_max: payloadWp === "REMOTE" ? 0 : payloadWp === "HYBRID" ? 3 : 5,
            attendance_basis: payloadWp === "REMOTE" ? "REMOTE" : payloadWp === "HYBRID" ? "POLICY_HYBRID_3_2" : "EMPLOYER_STATED",
            territory_restriction: null,
            work_auth_restriction: null,
            evidence_quote: `Payload workplaceType: ${payloadWp}`,
            source_type: "STRUCTURED_METADATA",
            status: "ENRICHED",
            fingerprint,
          };
          await persistEnrichmentResult(clientOrPool, context, job, result).catch(() => undefined);
          return result;
        }
      }
    }
  } catch (err: any) {
    if (err?.code !== "42P01") throw err;
  }

  // 4. Fetch canonical posting URL
  if (job.canonical_url) {
    const fetched = await fetchCanonicalWorkMode(job.canonical_url);
    const result: WorkModeEnrichmentResult = {
      ...fetched,
      source_type: "CANONICAL_PAGE",
      fingerprint,
    };
    await persistEnrichmentResult(clientOrPool, context, job, result).catch(() => undefined);
    return result;
  }

  const fallbackResult: WorkModeEnrichmentResult = {
    workplace_type: "UNKNOWN",
    office_days_min: null,
    office_days_max: null,
    attendance_basis: "UNKNOWN",
    territory_restriction: null,
    work_auth_restriction: null,
    evidence_quote: null,
    source_type: "CANONICAL_PAGE",
    status: "GENUINELY_UNKNOWN",
    fingerprint,
  };
  await persistEnrichmentResult(clientOrPool, context, job, fallbackResult).catch(() => undefined);
  return fallbackResult;
}

async function persistEnrichmentResult(
  clientOrPool: pg.Pool | pg.PoolClient,
  context: WorkspaceContext,
  job: { canonical_job_id: string; job_version_id: string; canonical_url?: string | null },
  result: WorkModeEnrichmentResult
): Promise<void> {
  try {
    await clientOrPool.query(
      `INSERT INTO work_mode_enrichments (
         workspace_id, canonical_job_id, job_version_id, fingerprint,
         source_url, source_type, status, workplace_type,
         office_days_min, office_days_max, attendance_basis,
         territory_restriction, work_auth_restriction, evidence_quote,
         extractor_version, attempted_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW())
       ON CONFLICT (workspace_id, fingerprint) DO NOTHING`,
      [
        context.workspaceId,
        job.canonical_job_id,
        job.job_version_id,
        result.fingerprint,
        job.canonical_url || null,
        result.source_type,
        result.status,
        result.workplace_type,
        result.office_days_min,
        result.office_days_max,
        result.attendance_basis,
        result.territory_restriction,
        result.work_auth_restriction,
        result.evidence_quote,
        EXTRACTOR_VERSION,
      ]
    );
  } catch (error: any) {
    console.error("persistEnrichmentResult failed:", error?.message || error);
    if (error?.code !== "42P01") throw error;
  }
}
