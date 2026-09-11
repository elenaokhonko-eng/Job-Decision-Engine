import pg from "pg";
import dotenv from "dotenv";
import { pgPoolConfig } from "../db/pgSsl.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../workspace/context.js";
import { computeEvidenceStrength, loadActiveEvidenceStrengthPolicy } from "../evidence/evidenceStrengthPolicy.js";
import { calculateProfessionalExperienceYears, compareStructuredRequirement } from "./requirementComparators.js";
import { buildPipelineTaskContextFingerprint } from "./artifactContext.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

const defaultPool = new pg.Pool(pgPoolConfig(process.env.DATABASE_URL));

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
  source_type?: "PROFILE_FACT" | "CREDENTIAL";
  embedding_node_id?: string;
  fact_type: string;
  statement: string;
  evidence_tier: string;
  verification_status: string;
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

function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (vecA.length === 0 || vecB.length === 0 || vecA.length !== vecB.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i += 1) {
    dot += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
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
    fact.verification_status,
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

const SEMANTIC_MATCH_THRESHOLD = 0.45;

type MatchableNodeType = "JOB_REQUIREMENT" | "PROFILE_FACT";

interface MatchableNodeEmbeddingRow {
  node_id: string;
  vector_dimensions: number;
  embedding_values: number[];
}

async function listSemanticEmbeddingSpaceCandidates(
  client: { query: pg.PoolClient["query"] },
  ctx: WorkspaceContext
): Promise<string[]> {
  try {
    const primary = await client.query<{ id: string }>(
      `SELECT id
       FROM embedding_spaces
       WHERE workspace_id = $1
         AND active = TRUE
         AND is_fallback_space = FALSE
       ORDER BY created_at DESC
       LIMIT 1`,
      [ctx.workspaceId]
    );

    const fallback = await client.query<{ id: string }>(
      `SELECT id
       FROM embedding_spaces
       WHERE workspace_id = $1
         AND active = TRUE
         AND is_fallback_space = TRUE
       ORDER BY created_at DESC
       LIMIT 1`,
      [ctx.workspaceId]
    );

    const candidates = [primary.rows[0]?.id, fallback.rows[0]?.id].filter(
      (id): id is string => typeof id === "string" && id.length > 0
    );
    return candidates;
  } catch (error: any) {
    if (error?.code === "42P01") {
      return [];
    }
    throw error;
  }
}

async function countMatchableNodes(
  client: { query: pg.PoolClient["query"] },
  ctx: WorkspaceContext,
  embeddingSpaceId: string,
  nodeType: MatchableNodeType,
  nodeIds: string[]
): Promise<number> {
  if (!embeddingSpaceId || nodeIds.length === 0) {
    return 0;
  }

  try {
    const res = await client.query<{ n: number }>(
      `SELECT COUNT(DISTINCT node_id)::int AS n
       FROM v_matchable_nodes
       WHERE workspace_id = $1
         AND embedding_space_id = $2
         AND node_type = $3
         AND node_id = ANY($4::uuid[])`,
      [ctx.workspaceId, embeddingSpaceId, nodeType, nodeIds]
    );
    return res.rows[0]?.n ?? 0;
  } catch (error: any) {
    if (error?.code === "42P01") {
      return 0;
    }
    throw error;
  }
}

async function loadNodeEmbeddings(
  client: { query: pg.PoolClient["query"] },
  ctx: WorkspaceContext,
  embeddingSpaceId: string,
  nodeType: MatchableNodeType,
  nodeIds: string[]
): Promise<Map<string, number[]>> {
  if (nodeIds.length === 0) {
    return new Map();
  }

  try {
    const res = await client.query<MatchableNodeEmbeddingRow>(
      `SELECT node_id, vector_dimensions, embedding_values
       FROM v_matchable_nodes
       WHERE workspace_id = $1
         AND embedding_space_id = $2
         AND node_type = $3
         AND node_id = ANY($4::uuid[])`,
      [ctx.workspaceId, embeddingSpaceId, nodeType, nodeIds]
    );

    const out = new Map<string, number[]>();
    for (const row of res.rows) {
      const vec = Array.isArray(row.embedding_values) ? row.embedding_values.map(Number) : [];
      if (vec.length > 0 && vec.length === Number(row.vector_dimensions)) {
        out.set(row.node_id, vec);
      }
    }
    return out;
  } catch (error: any) {
    if (error?.code === "42P01") {
      return new Map();
    }
    throw error;
  }
}

async function hasCompletedDeterministicRequirements(
  client: { query: pg.PoolClient["query"] },
  ctx: WorkspaceContext,
  jobVersionId: string
): Promise<boolean> {
  const { rows } = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM job_versions jv
       JOIN job_version_pipeline_state ps
         ON ps.workspace_id = jv.workspace_id
        AND ps.job_version_id = jv.id
        AND ps.current_stage = 'REQUIREMENTS_EXTRACTED'
        AND ps.stage_status = 'COMPLETED'
       JOIN requirement_extraction_runs rer
         ON rer.workspace_id = jv.workspace_id
        AND rer.job_version_id = jv.id
        AND rer.run_type = 'DETERMINISTIC'
        AND rer.status = 'COMPLETED'
        AND jv.active_requirement_set_id IS NOT NULL
        AND rer.requirement_set_id = jv.active_requirement_set_id
       WHERE jv.workspace_id = $1
         AND jv.id = $2
     ) AS exists`,
    [ctx.workspaceId, jobVersionId]
  );
  return Boolean(rows[0]?.exists);
}

export async function runDeterministicMatcher(
  clientOrPool?: pg.Pool | pg.PoolClient,
  options?: {
    context?: WorkspaceContext;
    jobVersionIds?: string[];
    canonicalJobIds?: string[];
    limit?: number;
  }
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
    const ctx = options?.context ?? (await resolveWorkspaceContext(client as any));

    const profileRes = await client.query<{ id: string }>(
      `SELECT pv.id
       FROM profile_versions pv
       WHERE pv.workspace_id = $1
         AND pv.status = 'ACTIVE'
       ORDER BY pv.created_at DESC
       LIMIT 1`,
      [ctx.workspaceId]
    );

    if (profileRes.rows.length === 0) {
      throw new Error("No ACTIVE profile version found; deterministic matching cannot run.");
    }

    const profileVersionId = profileRes.rows[0].id;

    const factsRes = await client.query<FactRow>(
      `SELECT pf.id, COALESCE(pf.fact_revision_id, pf.id) AS embedding_node_id,
              pf.fact_type, pf.statement, pf.evidence_tier, pf.verification_status, pf.structured_value
       FROM profile_facts pf
       WHERE pf.workspace_id = $1
         AND pf.profile_version_id = $2`,
      [ctx.workspaceId, profileVersionId]
    );

    let credentialFacts: FactRow[] = [];
    try {
      const credentialRes = await client.query<{
        id: string;
        credential_name: string;
        issuer: string;
        credential_type: string;
        level: string | null;
      }>(
        `SELECT pc.id, pc.credential_name, pc.issuer, pc.credential_type, pc.level
         FROM profile_credentials pc
         JOIN profile_versions pv
           ON pv.workspace_id = pc.workspace_id
          AND pv.id = pc.profile_version_id
          AND pv.status = 'ACTIVE'
         WHERE pc.workspace_id = $1
           AND pc.status = 'ACTIVE'`,
        [ctx.workspaceId]
      );
      credentialFacts = credentialRes.rows.map((credential) => ({
        id: credential.id,
        fact_type: credential.credential_type,
        statement: `${credential.credential_name} ${credential.issuer} ${credential.level || ""}`.trim(),
        evidence_tier: "PROFESSIONAL_PRODUCTION",
        verification_status: "VERIFIED",
        structured_value: { credential_type: credential.credential_type, level: credential.level },
        source_type: "CREDENTIAL",
      }));
    } catch (error: any) {
      if (error?.code !== "42P01") throw error;
    }
    try {
      const engagementRes = await client.query<{
        start_date: string;
        end_date: string | null;
        is_current: boolean;
        experience_class: string;
      }>(
        `SELECT start_date, end_date, is_current, experience_class
         FROM profile_engagements
         WHERE profile_version_id = $1`,
        [profileVersionId]
      );
      const experienceYears = calculateProfessionalExperienceYears(engagementRes.rows);
      if (experienceYears > 0) {
        credentialFacts.push({
          id: `experience:${profileVersionId}`,
          fact_type: "EXPERIENCE_YEARS",
          statement: `${experienceYears.toFixed(1)} years of professional production experience`,
          evidence_tier: "PROFESSIONAL_PRODUCTION",
          verification_status: "VERIFIED",
          structured_value: { professional_years: experienceYears },
          source_type: "CREDENTIAL",
        });
      }
    } catch (error: any) {
      if (error?.code !== "42P01") throw error;
    }
    const comparisonFacts = [...factsRes.rows, ...credentialFacts];
    if (comparisonFacts.length === 0) {
      throw new Error(
        `No profile facts or credentials found for ACTIVE profile version ${profileVersionId}; deterministic matching cannot run.`
      );
    }

    const jobVersionIds = options?.jobVersionIds?.filter(Boolean) ?? [];
    const canonicalJobIds = options?.canonicalJobIds?.filter(Boolean) ?? [];
    const hasExplicitTargets = jobVersionIds.length > 0 || canonicalJobIds.length > 0;
    const limit = Number.isInteger(options?.limit) && Number(options?.limit) > 0
      ? Number(options?.limit)
      : null;
    const jobParams: unknown[] = [ctx.workspaceId];
    const explicitTargetsParam = jobParams.push(hasExplicitTargets);
    const jobVersionFilter = jobVersionIds.length > 0
      ? `AND COALESCE(c.latest_job_version_id, jv.id) = ANY($${jobParams.push(jobVersionIds)}::uuid[])`
      : "";
    const canonicalJobFilter = canonicalJobIds.length > 0
      ? `AND c.id = ANY($${jobParams.push(canonicalJobIds)}::uuid[])`
      : "";
    const limitClause = limit ? `LIMIT $${jobParams.push(limit)}` : "";

    const { rows: jobs } = await client.query<RoutingCandidate>(
      `SELECT c.id,
              c.latest_job_version_id,
              COALESCE(c.latest_job_version_id, jv.id) AS resolved_job_version_id
       FROM canonical_jobs c
       LEFT JOIN LATERAL (
         SELECT id
         FROM job_versions
         WHERE workspace_id = $1
           AND canonical_job_id = c.id
         ORDER BY observed_at DESC
         LIMIT 1
       ) jv ON TRUE
        WHERE c.workspace_id = $1
         AND (
           COALESCE(c.processing_state, c.processing_status) = 'LANE_ROUTED'
           OR (
             $${explicitTargetsParam}::boolean
             AND COALESCE(c.processing_state, c.processing_status) IN (
               'MATCHED', 'QUEUED_FOR_AI', 'EVALUATING', 'AI_EVALUATED', 'EVALUATED'
             )
           )
         )
         AND c.primary_lane IS NOT NULL
         AND c.primary_lane != 'UNCLASSIFIED'
         ${jobVersionFilter}
         ${canonicalJobFilter}
       ORDER BY c.created_at ASC, c.id ASC
       ${limitClause}`,
      jobParams
    );

    const evidenceStrengthPolicy = await loadActiveEvidenceStrengthPolicy(client as any, {
      context: ctx,
    });
    const evidencePolicyRevisionId =
      evidenceStrengthPolicy.source === "REGISTRY"
        ? evidenceStrengthPolicy.configRevisionId ?? null
        : null;

    const factIds = [...new Set(factsRes.rows.map((row) => row.embedding_node_id || row.id))];
    const embeddingSpaceCandidates = await listSemanticEmbeddingSpaceCandidates(client as any, ctx);
    const semanticSpaceCandidates: string[] = [];
    for (const candidate of embeddingSpaceCandidates) {
      const availableFacts = await countMatchableNodes(
        client as any,
        ctx,
        candidate,
        "PROFILE_FACT",
        factIds
      );
      if (availableFacts === factIds.length) {
        semanticSpaceCandidates.push(candidate);
      }
    }
    const factEmbeddingsBySpace = new Map<string, Map<string, number[]>>();

    for (const job of jobs) {
      const versionId = job.resolved_job_version_id || job.latest_job_version_id;
      if (!versionId) {
        skippedJobs += 1;
        continue;
      }

      await client.query("BEGIN");
      try {
        const jobContextRes = await client.query<{
          active_requirement_set_id: string | null;
          content_hash: string | null;
        }>(
          `SELECT active_requirement_set_id, content_hash
           FROM job_versions
           WHERE workspace_id = $1 AND id = $2
           LIMIT 1`,
          [ctx.workspaceId, versionId]
        );
        const activeRequirementSetId = jobContextRes.rows[0]?.active_requirement_set_id ?? null;
        const jobContentHash = jobContextRes.rows[0]?.content_hash ?? null;
        const matchContextFingerprint = buildPipelineTaskContextFingerprint({
          workspaceId: ctx.workspaceId,
          taskType: "MATCH_PROFILE_EVIDENCE",
          taskVersion: "deterministic_matcher_v1",
          payload: {
            canonical_job_id: job.id,
            job_version_id: versionId,
            content_hash: jobContentHash,
            active_requirement_set_id: activeRequirementSetId,
            profile_version_id: profileVersionId,
            matcher_version: "deterministic_matcher_v1",
            evidence_strength_policy_hash: evidenceStrengthPolicy.policyHash,
          },
        });

        const runRes = await client.query<{ id: string }>(
          `INSERT INTO match_runs (
             workspace_id,
             canonical_job_id,
             job_version_id,
             profile_version_id,
             requirement_set_id,
             job_content_hash,
             context_fingerprint,
             status,
             policy_version,
             evidence_strength_policy_config_revision_id,
             evidence_strength_policy_hash
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'STARTED', 'deterministic_v1', $8, $9)
           RETURNING id`,
          [
            ctx.workspaceId,
            job.id,
            versionId,
            profileVersionId,
            activeRequirementSetId,
            jobContentHash,
            matchContextFingerprint,
            evidencePolicyRevisionId,
            evidenceStrengthPolicy.policyHash,
          ]
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
           FROM job_versions jv
           JOIN job_requirements jr
             ON jr.workspace_id = jv.workspace_id
            AND (
              jv.active_requirement_set_id IS NOT NULL
              AND jr.requirement_set_id = jv.active_requirement_set_id
            )
           WHERE jv.workspace_id = $1
             AND jv.id = $2
             AND jr.status = 'VALIDATED'
           ORDER BY jr.requirement_key ASC`,
          [ctx.workspaceId, versionId]
        );

        if (reqRes.rows.length === 0) {
          const requirementsStageComplete = await hasCompletedDeterministicRequirements(
            client as any,
            ctx,
            versionId
          );
          if (requirementsStageComplete) {
            await client.query(
              `UPDATE match_runs
               SET status = 'COMPLETED',
                   requirement_count = 0,
                   matched_count = 0,
                   coverage_score = 0,
                   overall_match_score = 0,
                   embedding_space_id = NULL,
                   completed_at = NOW()
               WHERE id = $1`,
              [matchRunId]
            );

            await client.query(
              `UPDATE canonical_jobs
               SET deterministic_match_score = 0,
                   deterministic_match_coverage = 0,
                   latest_match_run_id = $2,
                   profile_match_status = 'NO_PROFILE_MATCH',
                   processing_state = 'MATCHED',
                   processing_status = 'MATCHED',
                   updated_at = NOW()
               WHERE workspace_id = $1
                 AND id = $3`,
              [ctx.workspaceId, matchRunId, job.id]
            );

            await client.query("COMMIT");
            matchedJobs += 1;
            continue;
          }

          await client.query(
            `UPDATE match_runs
             SET status = 'FAILED',
                 error_message = $2,
                 completed_at = NOW()
             WHERE id = $1`,
            [
              matchRunId,
              "No completed deterministic requirement extraction found; deterministic matching skipped.",
            ]
          );

          await client.query("COMMIT");
          errors += 1;
          continue;
        }

        const requirementIds = reqRes.rows.map((row) => row.id);

        let semanticEmbeddingSpaceId: string | null = null;
        for (const candidate of semanticSpaceCandidates) {
          const availableReqs = await countMatchableNodes(
            client as any,
            ctx,
            candidate,
            "JOB_REQUIREMENT",
            requirementIds
          );
          if (availableReqs === requirementIds.length) {
            semanticEmbeddingSpaceId = candidate;
            break;
          }
        }

        const factEmbeddings =
          semanticEmbeddingSpaceId
            ? factEmbeddingsBySpace.get(semanticEmbeddingSpaceId) ||
              (await loadNodeEmbeddings(
                client as any,
                ctx,
                semanticEmbeddingSpaceId,
                "PROFILE_FACT",
                factIds
              ))
            : new Map<string, number[]>();
        if (semanticEmbeddingSpaceId && !factEmbeddingsBySpace.has(semanticEmbeddingSpaceId)) {
          factEmbeddingsBySpace.set(semanticEmbeddingSpaceId, factEmbeddings);
        }

        const requirementEmbeddings =
          semanticEmbeddingSpaceId && requirementIds.length > 0
            ? await loadNodeEmbeddings(
                client as any,
                ctx,
                semanticEmbeddingSpaceId,
                "JOB_REQUIREMENT",
                requirementIds
              )
            : new Map<string, number[]>();

        const usedEmbeddings =
          !!semanticEmbeddingSpaceId &&
          factEmbeddings.size === factIds.length &&
          requirementEmbeddings.size === requirementIds.length;

        let weightedScoreSum = 0;
        let weightSum = 0;
        let matchedCount = 0;

        for (const req of reqRes.rows) {
          const weight = requirementWeight(req.importance);
          weightSum += weight;

          if (comparisonFacts.length === 0) {
            await client.query(
              `INSERT INTO requirement_evidence_matches (
                 workspace_id,
                 match_run_id,
                 requirement_id,
                 profile_fact_id,
                 match_type,
                 match_score,
                 rationale,
                 evidence
               )
               VALUES ($1, $2, $3, NULL, 'UNKNOWN', 0, $4, $5)`,
              [
                ctx.workspaceId,
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
          let bestLexical = 0;
          let bestSemantic = 0;
          const reqEmbedding = usedEmbeddings ? requirementEmbeddings.get(req.id) ?? null : null;

          const structuredComparison = compareStructuredRequirement(req, comparisonFacts);
          const exactRequirementType = ["EXPERIENCE_YEARS", "CREDENTIAL", "DEGREE", "WORK_AUTH"].includes(req.requirement_type);
          if (exactRequirementType && structuredComparison.status === "UNKNOWN") {
            await client.query(
              `INSERT INTO requirement_evidence_matches (
                 workspace_id, match_run_id, requirement_id, profile_fact_id,
                 match_type, match_score, rationale, evidence
               ) VALUES ($1, $2, $3, NULL, 'UNKNOWN', 0, $4, $5)`,
              [
                ctx.workspaceId,
                matchRunId,
                req.id,
                structuredComparison.rationale,
                JSON.stringify({
                  requirement_key: req.requirement_key,
                  requirement_type: req.requirement_type,
                  comparator: "STRUCTURED_EXACT",
                  semantic_ready: usedEmbeddings,
                }),
              ]
            );
            continue;
          }
          if (structuredComparison.status === "MISMATCH") {
            await client.query(
              `INSERT INTO requirement_evidence_matches (
                 workspace_id, match_run_id, requirement_id, profile_fact_id,
                 match_type, match_score, rationale, evidence
               ) VALUES ($1, $2, $3, $4, 'NO_MATCH', 0, $5, $6)`,
              [
                ctx.workspaceId,
                matchRunId,
                req.id,
                structuredComparison.fact?.id || null,
                structuredComparison.rationale,
                JSON.stringify({
                  requirement_key: req.requirement_key,
                  requirement_type: req.requirement_type,
                  comparator: "STRUCTURED_EXACT",
                  semantic_ready: usedEmbeddings,
                }),
              ]
            );
            continue;
          }

          if (structuredComparison.status === "MATCH") {
            bestFact = structuredComparison.fact as FactRow;
            bestScore = 1;
            bestLexical = 1;
            bestSemantic = 1;
          }

          for (const fact of factsRes.rows) {
            if (structuredComparison.status === "MATCH") break;
            const lexicalScore = scoreMatch(req, fact);
            let semanticScore = 0;
            if (reqEmbedding) {
              const factEmbedding = factEmbeddings.get(fact.embedding_node_id || fact.id);
              if (factEmbedding) {
                semanticScore = Math.max(0, cosineSimilarity(reqEmbedding, factEmbedding));
              }
            }
            const score = usedEmbeddings ? lexicalScore * 0.35 + semanticScore * 0.65 : lexicalScore;
            if (score > bestScore) {
              bestScore = score;
              bestLexical = lexicalScore;
              bestSemantic = semanticScore;
              bestFact = fact;
            }
          }

          const evidenceStrength = bestFact
            ? computeEvidenceStrength(
                bestFact.evidence_tier as any,
                bestFact.verification_status as any,
                evidenceStrengthPolicy.policy
              )
            : 0;

          let matchType: 'EXACT' | 'SEMANTIC' | 'NO_MATCH' | 'UNKNOWN' = 'NO_MATCH';
          if (usedEmbeddings) {
            if (structuredComparison.status === "MATCH") {
              matchType = 'EXACT';
            } else if (bestScore >= SEMANTIC_MATCH_THRESHOLD) {
              matchType = 'SEMANTIC';
            }
          } else if (bestScore >= 0.2) {
            // Embeddings are not fully published for this job+profile; preserve a pending record
            // without treating lexical similarity as a semantic match.
            matchType = 'UNKNOWN';
          }

          const isCountedMatch = matchType === 'EXACT' || (matchType === 'SEMANTIC' && evidenceStrength >= 0.4);
          const weightedScore = isCountedMatch ? bestScore * evidenceStrength : 0;
          weightedScoreSum += weightedScore * weight;
          if (isCountedMatch) {
            matchedCount += 1;
          }

          const profileFactId = bestFact?.source_type === "CREDENTIAL" ? null : bestFact?.id || null;

          await client.query(
            `INSERT INTO requirement_evidence_matches (
               workspace_id,
               match_run_id,
               requirement_id,
               profile_fact_id,
               match_type,
               match_score,
               rationale,
               evidence
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              ctx.workspaceId,
              matchRunId,
              req.id,
              profileFactId,
              matchType,
              bestScore,
              matchType === 'NO_MATCH'
                ? 'No sufficient lexical/semantic overlap found.'
                : bestFact?.source_type === "CREDENTIAL"
                  ? `Matched against profile credential ${bestFact.id}.`
                  : `Matched against profile fact ${bestFact?.id}.`,
               JSON.stringify({
                 requirement_key: req.requirement_key,
                 requirement_type: req.requirement_type,
                 matched_fact_type: bestFact?.fact_type || null,
                 evidence_tier: bestFact?.evidence_tier || null,
                 verification_status: bestFact?.verification_status || null,
                 evidence_strength: bestFact ? evidenceStrength : null,
                 lexical_score: bestFact ? Number(bestLexical.toFixed(6)) : null,
                 semantic_score: usedEmbeddings && bestFact ? Number(bestSemantic.toFixed(6)) : null,
                 match_method: bestFact
                   ? usedEmbeddings
                     ? bestSemantic > bestLexical
                       ? "EMBEDDING"
                       : "LEXICAL"
                     : "PENDING_EMBEDDINGS"
                   : null,
                 embedding_space_id: usedEmbeddings ? semanticEmbeddingSpaceId : null,
                 weighted_score: bestFact ? Number(weightedScore.toFixed(6)) : null,
                 semantic_ready: usedEmbeddings,
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
               embedding_space_id = $6,
               completed_at = NOW()
           WHERE id = $1`,
          [
            matchRunId,
            reqCount,
            matchedCount,
            coverageScore,
            overallScore,
            usedEmbeddings ? semanticEmbeddingSpaceId : null,
          ]
        );

        await client.query(
          `UPDATE canonical_jobs
           SET deterministic_match_score = $2,
               deterministic_match_coverage = $3,
               latest_match_run_id = $4,
               profile_match_status = CASE WHEN $6::int > 0 THEN 'POSITIVE_MATCH' ELSE 'NO_PROFILE_MATCH' END,
               processing_state = 'MATCHED',
               processing_status = 'MATCHED',
               updated_at = NOW()
           WHERE workspace_id = $1
             AND id = $5`,
          [ctx.workspaceId, overallScore, coverageScore, matchRunId, job.id, matchedCount]
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
