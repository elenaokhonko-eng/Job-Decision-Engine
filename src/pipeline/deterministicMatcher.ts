import pg from "pg";
import dotenv from "dotenv";
import { pgSslConfig } from "../db/pgSsl.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

const defaultPool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: pgSslConfig(process.env.DATABASE_URL)
});

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "this", "that", "your", "you", "our", "are", "will", "have", "has", "into", "role", "job", "years", "year", "must", "plus", "required", "preferred"
]);

interface RoutingCandidate {
  id: string;
  latest_job_version_id: string | null;
  resolved_job_version_id: string | null;
}

interface RequirementRow {
  id: string;
  requirement_key: string;
  requirement_type: string;
  importance: "MUST" | "PREFERRED" | "NICE_TO_HAVE";
  requirement_text: string;
  quote_text: string | null;
  structured_value: Record<string, unknown> | null;
}

interface FactRow {
  id: string;
  fact_type: string;
  statement: string;
  evidence_tier: string;
  structured_value: Record<string, unknown> | null;
}

export interface DeterministicMatchSummary {
  matchedJobs: number;
  skippedJobs: number;
  errors: number;
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2 && !STOP_WORDS.has(t))
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) {
      intersection += 1;
    }
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function flattenStructuredValue(value: Record<string, unknown> | null): string {
  if (!value) {
    return "";
  }
  return Object.values(value)
    .map((v) => {
      if (Array.isArray(v)) {
        return v.join(" ");
      }
      if (typeof v === "object" && v !== null) {
        return JSON.stringify(v);
      }
      return String(v);
    })
    .join(" ");
}

function buildRequirementText(req: RequirementRow): string {
  return [
    req.requirement_type,
    req.requirement_text,
    req.quote_text || "",
    flattenStructuredValue(req.structured_value),
  ]
    .join(" ")
    .trim();
}

function buildFactText(fact: FactRow): string {
  return [
    fact.fact_type,
    fact.statement,
    fact.evidence_tier,
    flattenStructuredValue(fact.structured_value),
  ]
    .join(" ")
    .trim();
}

function requirementWeight(importance: RequirementRow["importance"]): number {
  if (importance === "MUST") {
    return 1.0;
  }
  if (importance === "PREFERRED") {
    return 0.7;
  }
  return 0.4;
}

function scoreMatch(requirement: RequirementRow, fact: FactRow): number {
  const requirementTokens = tokenize(buildRequirementText(requirement));
  const factTokens = tokenize(buildFactText(fact));
  let score = jaccard(requirementTokens, factTokens);

  if (requirement.requirement_type === "DOMAIN" || requirement.requirement_type === "FUNCTION") {
    const structured = flattenStructuredValue(requirement.structured_value).toLowerCase();
    if (structured.length > 0 && buildFactText(fact).toLowerCase().includes(structured)) {
      score += 0.2;
    }
  }

  if (fact.fact_type === requirement.requirement_type) {
    score += 0.1;
  }

  return Math.min(1, score);
}

export async function runDeterministicMatcher(
  clientOrPool?: pg.Pool | pg.PoolClient
): Promise<DeterministicMatchSummary> {
  console.log("Starting Deterministic Matcher...");

  const pool = clientOrPool || defaultPool;
  const isPool = (value: pg.Pool | pg.PoolClient): value is pg.Pool =>
    typeof (value as pg.Pool).connect === "function" && !("release" in value);
  const ownsClient = isPool(pool);
  const client = ownsClient ? await pool.connect() : pool;

  let matchedJobs = 0;
  let skippedJobs = 0;
  let errors = 0;

  try {
    const profileRes = await client.query<{ id: string }>(
      `SELECT pv.id
       FROM profile_versions pv
       WHERE pv.status = 'ACTIVE'
       ORDER BY pv.created_at DESC
       LIMIT 1`
    );

    if (profileRes.rows.length === 0) {
      throw new Error("No ACTIVE profile version found; deterministic matching cannot run.");
    }

    const profileVersionId = profileRes.rows[0].id;

    const factsRes = await client.query<FactRow>(
      `SELECT pf.id, pf.fact_type, pf.statement, pf.evidence_tier, pf.structured_value
       FROM profile_facts pf
       WHERE pf.profile_version_id = $1`,
      [profileVersionId]
    );

    const { rows: jobs } = await client.query<RoutingCandidate>(
      `SELECT c.id,
              c.latest_job_version_id,
              COALESCE(c.latest_job_version_id, jv.id) AS resolved_job_version_id
       FROM canonical_jobs c
       LEFT JOIN LATERAL (
         SELECT id
         FROM job_versions
         WHERE canonical_job_id = c.id
         ORDER BY observed_at DESC
         LIMIT 1
       ) jv ON TRUE
       WHERE c.processing_status = 'LANE_ROUTED'
         AND c.primary_lane IS NOT NULL
         AND c.primary_lane != 'UNCLASSIFIED'`
    );

    for (const job of jobs) {
      const versionId = job.resolved_job_version_id || job.latest_job_version_id;
      if (!versionId) {
        skippedJobs += 1;
        continue;
      }

      await client.query("BEGIN");
      try {
        const runRes = await client.query<{ id: string }>(
          `INSERT INTO match_runs (
             canonical_job_id,
             job_version_id,
             profile_version_id,
             status,
             policy_version
           )
           VALUES ($1, $2, $3, 'STARTED', 'deterministic_v1')
           RETURNING id`,
          [job.id, versionId, profileVersionId]
        );
        const matchRunId = runRes.rows[0].id;

        const reqRes = await client.query<RequirementRow>(
          `SELECT jr.id,
                  jr.requirement_key,
                  jr.requirement_type,
                  jr.importance,
                  jr.requirement_text,
                  jr.quote_text,
                  jr.structured_value
           FROM job_requirements jr
           WHERE jr.job_version_id = $1
             AND jr.status = 'VALIDATED'
           ORDER BY jr.requirement_key ASC`,
          [versionId]
        );

        let weightedScoreSum = 0;
        let weightSum = 0;
        let matchedCount = 0;

        for (const req of reqRes.rows) {
          const weight = requirementWeight(req.importance);
          weightSum += weight;

          if (factsRes.rows.length === 0) {
            await client.query(
              `INSERT INTO requirement_evidence_matches (
                 match_run_id,
                 requirement_id,
                 profile_fact_id,
                 match_type,
                 match_score,
                 rationale,
                 evidence
               )
               VALUES ($1, $2, NULL, 'UNKNOWN', 0, $3, $4)`,
              [
                matchRunId,
                req.id,
                'No profile facts available for deterministic matching.',
                JSON.stringify({ reason: 'NO_PROFILE_FACTS' }),
              ]
            );
            continue;
          }

          let bestFact: FactRow | null = null;
          let bestScore = 0;

          for (const fact of factsRes.rows) {
            const score = scoreMatch(req, fact);
            if (score > bestScore) {
              bestScore = score;
              bestFact = fact;
            }
          }

          weightedScoreSum += bestScore * weight;

          let matchType: 'EXACT' | 'SEMANTIC' | 'NO_MATCH' = 'NO_MATCH';
          if (bestScore >= 0.85) {
            matchType = 'EXACT';
          } else if (bestScore >= 0.2) {
            matchType = 'SEMANTIC';
          }

          if (matchType !== 'NO_MATCH') {
            matchedCount += 1;
          }

          await client.query(
            `INSERT INTO requirement_evidence_matches (
               match_run_id,
               requirement_id,
               profile_fact_id,
               match_type,
               match_score,
               rationale,
               evidence
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              matchRunId,
              req.id,
              bestFact?.id || null,
              matchType,
              bestScore,
              matchType === 'NO_MATCH'
                ? 'No sufficient lexical/semantic overlap found.'
                : `Matched against profile fact ${bestFact?.id}.`,
              JSON.stringify({
                requirement_key: req.requirement_key,
                requirement_type: req.requirement_type,
                matched_fact_type: bestFact?.fact_type || null,
              }),
            ]
          );
        }

        const reqCount = reqRes.rows.length;
        const overallScore = weightSum > 0 ? (weightedScoreSum / weightSum) * 100 : 0;
        const coverageScore = reqCount > 0 ? (matchedCount / reqCount) * 100 : 0;

        await client.query(
          `UPDATE match_runs
           SET status = 'COMPLETED',
               requirement_count = $2,
               matched_count = $3,
               coverage_score = $4,
               overall_match_score = $5,
               completed_at = NOW()
           WHERE id = $1`,
          [matchRunId, reqCount, matchedCount, coverageScore, overallScore]
        );

        await client.query(
          `UPDATE canonical_jobs
           SET deterministic_match_score = $2,
               deterministic_match_coverage = $3,
               latest_match_run_id = $4,
               processing_status = 'MATCHED',
               updated_at = NOW()
           WHERE id = $1`,
          [job.id, overallScore, coverageScore, matchRunId]
        );

        await client.query("COMMIT");
        matchedJobs += 1;
      } catch (error) {
        await client.query("ROLLBACK");
        errors += 1;
        console.error(`Deterministic matching failed for canonical job ${job.id}:`, error);
      }
    }
  } finally {
    if (ownsClient && typeof client.release === "function") {
      client.release();
    }
  }

  console.log(
    `Deterministic Matcher complete. Matched: ${matchedJobs}, Skipped: ${skippedJobs}, Errors: ${errors}`
  );
  return { matchedJobs, skippedJobs, errors };
}
