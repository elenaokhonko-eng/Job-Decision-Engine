import crypto from "node:crypto";
import pg from "pg";
import dotenv from "dotenv";
import { SourceBroker } from "../src/ingestion/sourceBroker.js";
import { runNormalization } from "../src/pipeline/normalize.js";
import { MIN_COMPLETE_DESCRIPTION_CHARS, classifyDescriptionQuality } from "../src/pipeline/descriptionQuality.js";
import { enqueuePipelineTask } from "../src/tasks/pipelineTasks.js";
import { SourceNameSchema, type SourceName } from "../src/contracts/index.js";
import { pgConnectionConfig } from "../src/db/pgSsl.js";
import { resolveWorkspaceContext } from "../src/workspace/context.js";

dotenv.config();
dotenv.config({ path: ".env.local", override: true });

const MAX_JOBS = Math.max(1, Number.parseInt(process.env.SOURCE_ENRICHMENT_MAX_JOBS || "404", 10));
const FETCH_TIMEOUT_MS = Math.max(1_000, Number.parseInt(process.env.SOURCE_ENRICHMENT_TIMEOUT_MS || "15000", 10));

type Candidate = {
  canonical_job_id: string;
  job_version_id: string;
  title: string;
  company_name: string;
  description_text: string;
  source_name: string | null;
  source_url: string | null;
  canonical_apply_url: string | null;
  source_external_id: string | null;
};

type FetchResult =
  | { status: "ENRICHED"; description: string; contentType: string }
  | { status: "SKIPPED"; reason: string }
  | { status: "FAILED"; reason: string };

function safeSourceUrl(value: string | null): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
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

function decodeHtml(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, value: string) => String.fromCodePoint(Number(value)));
}

function textFromHtml(html: string): string {
  return decodeHtml(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
  ).trim();
}

function jsonLdDescriptions(html: string): string[] {
  const descriptions: string[] = [];
  const scripts = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) || [];
  for (const script of scripts) {
    const body = script.replace(/^<[\s\S]*?>/i, "").replace(/<\/script>$/i, "").trim();
    try {
      const parsed = JSON.parse(body) as unknown;
      const values = Array.isArray(parsed) ? parsed : [parsed];
      for (const value of values) {
        if (value && typeof value === "object") {
          const description = (value as Record<string, unknown>).description;
          if (typeof description === "string" && description.trim()) descriptions.push(textFromHtml(description));
          const graph = (value as Record<string, unknown>)["@graph"];
          if (Array.isArray(graph)) {
            for (const item of graph) {
              if (item && typeof item === "object" && typeof (item as Record<string, unknown>).description === "string") {
                descriptions.push(textFromHtml(String((item as Record<string, unknown>).description)));
              }
            }
          }
        }
      }
    } catch {
      // A malformed JSON-LD block is source-quality debt, not a career decision.
    }
  }
  return descriptions.filter(Boolean);
}

async function fetchDescription(sourceUrl: string | null): Promise<FetchResult> {
  const url = safeSourceUrl(sourceUrl);
  if (!url) return { status: "SKIPPED", reason: "SOURCE_URL_NOT_FETCHABLE" };
  if (isAuthenticatedSource(url)) {
    return { status: "SKIPPED", reason: "AUTHENTICATED_SOURCE_FETCH_REQUIRED" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.1",
        "user-agent": "JobDecisionEngine/1.0 source-enrichment",
      },
    });
    if (!response.ok) return { status: "FAILED", reason: `SOURCE_HTTP_${response.status}` };
    const contentType = response.headers.get("content-type") || "";
    const body = await response.text();
    const candidates = [
      ...jsonLdDescriptions(body),
      textFromHtml(body),
    ].sort((left, right) => right.length - left.length);
    const description = candidates.find((candidate) => classifyDescriptionQuality(candidate).status === "COMPLETE");
    if (!description) return { status: "SKIPPED", reason: "FETCHED_DESCRIPTION_BELOW_1000_CHAR_FLOOR" };
    return { status: "ENRICHED", description, contentType };
  } catch (error) {
    const reason = error instanceof Error && error.name === "AbortError"
      ? "SOURCE_FETCH_TIMEOUT"
      : "SOURCE_FETCH_FAILED";
    return { status: "FAILED", reason };
  } finally {
    clearTimeout(timeout);
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("Missing required DATABASE_URL.");

  const pool = new pg.Pool(pgConnectionConfig(databaseUrl));
  const ctx = await resolveWorkspaceContext(pool as any);
  const broker = new SourceBroker(pool, ctx);
  const sourceRunId = await broker.startRun("INCOMPLETE_DESCRIPTION_ENRICHMENT_RUN");

  let enriched = 0;
  let skipped = 0;
  let failed = 0;
  const stagedObservationIds: string[] = [];

  try {
    const { rows: candidates } = await pool.query<Candidate>(
      `SELECT c.id AS canonical_job_id,
              jv.id AS job_version_id,
              c.normalized_title AS title,
              c.company_name,
              jv.description_text,
              obs.source_name,
              COALESCE(obs.canonical_apply_url, obs.source_url, c.canonical_url) AS source_url,
              obs.canonical_apply_url,
              obs.source_external_id
       FROM canonical_jobs c
       JOIN job_versions jv
         ON jv.workspace_id = c.workspace_id
        AND jv.id = c.latest_job_version_id
       LEFT JOIN LATERAL (
         SELECT source_name, source_url, canonical_apply_url, source_external_id
         FROM raw_job_observations
         WHERE workspace_id = c.workspace_id
           AND job_version_id = jv.id
         ORDER BY retrieved_at DESC, id DESC
         LIMIT 1
       ) obs ON TRUE
       WHERE c.workspace_id = $1
         AND COALESCE(c.processing_state, c.processing_status) = 'NEEDS_VERIFICATION'
         AND COALESCE(c.description_quality_status, CASE
           WHEN length(BTRIM(jv.description_text)) >= 1000 THEN 'COMPLETE'
           WHEN NULLIF(BTRIM(jv.description_text), '') IS NULL THEN 'UNKNOWN'
           ELSE 'INCOMPLETE'
         END) <> 'COMPLETE'
       ORDER BY c.updated_at ASC, c.id ASC
       LIMIT $2`,
      [ctx.workspaceId, MAX_JOBS]
    );

    console.log(`Source enrichment candidates: ${candidates.length}`);
    for (const candidate of candidates) {
      const result = await fetchDescription(candidate.source_url);
      if (result.status !== "ENRICHED") {
        if (result.status === "FAILED") failed += 1;
        else skipped += 1;
        console.log(`  ${candidate.canonical_job_id}: ${result.reason}`);
        continue;
      }

      const sourceName = SourceNameSchema.safeParse(candidate.source_name || "");
      if (!sourceName.success) {
        skipped += 1;
        console.log(`  ${candidate.canonical_job_id}: UNSUPPORTED_SOURCE_NAME`);
        continue;
      }

      const descriptionHash = crypto.createHash("sha256").update(result.description).digest("hex");
      await broker.processObservation(
        {
          sourceName: sourceName.data as SourceName,
          sourceExternalId: `${candidate.source_external_id || candidate.canonical_job_id}:enriched:${descriptionHash.slice(0, 16)}`,
          sourceUrl: candidate.source_url || candidate.canonical_apply_url || "",
          retrievedAt: new Date().toISOString(),
          companyName: candidate.company_name,
          title: candidate.title,
          descriptionRaw: result.description,
          locationRaw: "Unknown",
          workplaceTypeRaw: "UNKNOWN",
          employmentTypeRaw: "UNKNOWN",
          canonicalApplyUrl: candidate.canonical_apply_url || candidate.source_url || "",
          sourceLane: "UNKNOWN",
          searchPlanVersion: "source_enrichment_v1",
          rawPayload: {
            enrichment_type: "SOURCE_HTML_DESCRIPTION",
            source_url_host: candidate.source_url ? new URL(candidate.source_url).hostname : null,
            content_type: result.contentType,
            description_sha256: descriptionHash,
          },
        },
        { description: result.description, description_sha256: descriptionHash }
      );
      enriched += 1;
    }

    const { rows: stagedRows } = await pool.query<{ id: string }>(
      `SELECT id
       FROM raw_job_observations
       WHERE workspace_id = $1 AND source_run_id = $2
       ORDER BY retrieved_at ASC, id ASC`,
      [ctx.workspaceId, sourceRunId]
    );
    stagedObservationIds.push(...stagedRows.map((row) => row.id));

    if (stagedObservationIds.length > 0) {
      const normalized = await runNormalization(pool, {
        context: ctx,
        observationIds: stagedObservationIds,
      });
      if (normalized.totalErrors > 0) {
        throw new Error(`Normalization failed for ${normalized.totalErrors} enriched observation(s).`);
      }

      for (const detail of normalized.details) {
        if (!detail.versionId) continue;
        await enqueuePipelineTask(
          {
            taskType: "EXTRACT_DETERMINISTIC_REQUIREMENTS",
            taskKey: `EXTRACT_DETERMINISTIC_REQUIREMENTS:${detail.versionId}:source_enrichment_v1`,
            payload: {
              canonical_job_id: detail.canonicalJobId,
              job_version_id: detail.versionId,
              reprocess_existing_state: true,
            },
          },
          pool,
          { context: ctx }
        );
      }
    }

    await broker.endRun(failed > 0 ? (enriched > 0 ? "DEGRADED" : "FAILED") : "COMPLETED");
    console.log(JSON.stringify({
      workspace_id: ctx.workspaceId,
      candidates: candidates.length,
      enriched,
      skipped,
      failed,
      staged_observations: stagedObservationIds.length,
      minimum_complete_description_chars: MIN_COMPLETE_DESCRIPTION_CHARS,
    }, null, 2));
    if (failed > 0 && enriched === 0) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && process.argv[1].includes("enrich_incomplete_descriptions")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
