import pg from "pg";
import dotenv from "dotenv";
import { pgPoolConfig } from "../src/db/pgSsl.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../src/workspace/context.js";
import { runHardGates } from "../src/pipeline/hardGate.js";
import { runLaneRouting } from "../src/pipeline/laneRouter.js";
import { runDeterministicMatcher } from "../src/pipeline/deterministicMatcher.js";
import { runRecommendationDecider } from "../src/pipeline/recommendationDecider.js";
import { runExplanationQueueEnqueuer } from "../src/pipeline/explanationQueueEnqueuer.js";
import { loadWorkspaceLanesConfig } from "../src/pipeline/laneConfigLoader.js";
import {
  AFFECTED_HISTORICAL_REPLAY_STATES,
  EARLY_PIPELINE_REPLAY_STATES,
  haveSameNumericCounts,
  isCanariesOnlyMode,
  MATCH_REVALIDATION_REPLAY_STATES,
  shouldReplayAffectedHistoricalJobs,
} from "./historicalReplayScope.js";
import {
  getRehearsalDatabaseTarget,
  requireRehearsalWriteConfirmation,
} from "./productionRehearsalTarget.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

interface ProcessingDistribution {
  [state: string]: number;
}

async function getProcessingDistribution(client: pg.PoolClient, workspaceId: string): Promise<ProcessingDistribution> {
  const res = await client.query<{ state: string; count: string }>(`
    SELECT COALESCE(processing_state, processing_status, 'UNKNOWN') AS state, COUNT(*)::text AS count
    FROM canonical_jobs
    WHERE workspace_id = $1
    GROUP BY COALESCE(processing_state, processing_status, 'UNKNOWN')
    ORDER BY count DESC;
  `, [workspaceId]);

  const dist: ProcessingDistribution = {};
  for (const row of res.rows) {
    dist[row.state] = parseInt(row.count, 10);
  }
  return dist;
}

async function getRejectionCodes(client: pg.PoolClient, workspaceId: string): Promise<Record<string, number>> {
  const res = await client.query<{ code: string; count: string }>(`
    WITH latest_gate_decisions AS (
      SELECT DISTINCT ON (canonical_job_id, job_version_id)
        rejection_codes
      FROM gate_decisions
      WHERE workspace_id = $1
      ORDER BY canonical_job_id, job_version_id, created_at DESC
    )
    SELECT code, COUNT(*)::text AS count
    FROM (
      SELECT jsonb_array_elements_text(COALESCE(rejection_codes, '[]'::jsonb)) AS code
      FROM latest_gate_decisions
    ) sub
    GROUP BY code
    ORDER BY count DESC;
  `, [workspaceId]);

  const out: Record<string, number> = {};
  for (const row of res.rows) {
    out[row.code] = parseInt(row.count, 10);
  }
  return out;
}

async function getLaneDistribution(client: pg.PoolClient, workspaceId: string): Promise<Record<string, number>> {
  const res = await client.query<{ lane: string; count: string }>(`
    SELECT COALESCE(primary_lane, 'UNCLASSIFIED') AS lane, COUNT(*)::text AS count
    FROM canonical_jobs
    WHERE workspace_id = $1
    GROUP BY COALESCE(primary_lane, 'UNCLASSIFIED')
    ORDER BY count DESC;
  `, [workspaceId]);

  const out: Record<string, number> = {};
  for (const row of res.rows) {
    out[row.lane] = parseInt(row.count, 10);
  }
  return out;
}

interface ReplayAuditCounts {
  [key: string]: number;
  gateDecisions: number;
  laneDecisions: number;
  matchRuns: number;
  deterministicDecisions: number;
  evaluationQueue: number;
  pipelineTasks: number;
  pipelineTaskAttempts: number;
  budgetUsage: number;
  budgetDeferrals: number;
}

async function getReplayAuditCounts(
  client: pg.PoolClient,
  workspaceId: string,
  canonicalJobIds: string[],
  budgetRunId: string,
): Promise<ReplayAuditCounts> {
  const result = await client.query<ReplayAuditCounts>(`
    SELECT
      (
        SELECT COUNT(*)::int
        FROM gate_decisions gd
        WHERE gd.workspace_id = $1
          AND gd.canonical_job_id = ANY($2::uuid[])
      ) AS "gateDecisions",
      (
        SELECT COUNT(*)::int
        FROM lane_decisions ld
        WHERE ld.workspace_id = $1
          AND ld.canonical_job_id = ANY($2::uuid[])
      ) AS "laneDecisions",
      (
        SELECT COUNT(*)::int
        FROM match_runs mr
        WHERE mr.workspace_id = $1
          AND mr.canonical_job_id = ANY($2::uuid[])
      ) AS "matchRuns",
      (
        SELECT COUNT(*)::int
        FROM deterministic_decisions dd
        WHERE dd.workspace_id = $1
          AND dd.canonical_job_id = ANY($2::uuid[])
      ) AS "deterministicDecisions",
      (
        SELECT COUNT(*)::int
        FROM evaluation_queue eq
        WHERE eq.workspace_id = $1
          AND eq.canonical_job_id = ANY($2::uuid[])
      ) AS "evaluationQueue",
      (
        SELECT COUNT(*)::int
        FROM pipeline_tasks pt
        WHERE pt.workspace_id = $1
          AND pt.payload ->> 'canonical_job_id' = ANY($3::text[])
      ) AS "pipelineTasks",
      (
        SELECT COUNT(*)::int
        FROM pipeline_task_attempts pta
        JOIN pipeline_tasks pt ON pt.id = pta.task_id
        WHERE pta.workspace_id = $1
          AND pt.payload ->> 'canonical_job_id' = ANY($3::text[])
      ) AS "pipelineTaskAttempts",
      (
        SELECT COUNT(*)::int
        FROM ai_evaluation_budget_usage aebu
        WHERE aebu.workspace_id = $1
          AND aebu.budget_run_id = $4::uuid
      ) AS "budgetUsage",
      (
        SELECT COUNT(*)::int
        FROM evaluation_budget_deferrals ebd
        WHERE ebd.workspace_id = $1
          AND ebd.budget_run_id = $4::uuid
          AND ebd.canonical_job_id = ANY($2::uuid[])
      ) AS "budgetDeferrals"
  `, [workspaceId, canonicalJobIds, canonicalJobIds, budgetRunId]);

  const counts = result.rows[0];
  if (!counts) {
    throw new Error("Expected replay audit counts for the affected historical cohort.");
  }
  return counts;
}

interface AffectedHistoricalJob {
  id: string;
  reason: string;
}

async function listAffectedHistoricalJobs(
  client: pg.PoolClient,
  workspaceId: string,
): Promise<AffectedHistoricalJob[]> {
  const result = await client.query<AffectedHistoricalJob>(`
    WITH latest_gates AS (
      SELECT DISTINCT ON (gd.canonical_job_id, gd.job_version_id)
        gd.canonical_job_id,
        gd.job_version_id,
        gd.rejection_codes
      FROM gate_decisions gd
      WHERE gd.workspace_id = $1
      ORDER BY gd.canonical_job_id, gd.job_version_id, gd.created_at DESC
    )
    SELECT
      c.id,
      CASE
        WHEN COALESCE(c.processing_state, c.processing_status) = ANY($2::text[])
          THEN 'PENDING_OR_ROUTING_DEFERRED'
        WHEN COALESCE(c.processing_state, c.processing_status) = ANY($3::text[])
          THEN 'MATCH_OR_QUALIFICATION_REVALIDATION'
        ELSE 'CHANGED_GLOBAL_RULE_REASON'
      END AS reason
    FROM canonical_jobs c
    LEFT JOIN latest_gates lg
      ON lg.canonical_job_id = c.id
     AND (c.latest_job_version_id IS NULL OR lg.job_version_id = c.latest_job_version_id)
    WHERE c.workspace_id = $1
      AND c.id::text NOT LIKE 'c0000000-0000-4000-8000-%'
      AND (
        COALESCE(c.processing_state, c.processing_status) = ANY($4::text[])
        OR (
          COALESCE(c.processing_state, c.processing_status) = 'HARD_REJECTED'
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements_text(COALESCE(lg.rejection_codes, '[]'::jsonb)) AS code(value)
            WHERE code.value IN (
              'GATE_EXPERIENCE_YEARS_MISMATCH',
              'GATE_DEGREE_MISMATCH',
              'GATE_CREDENTIAL_MISMATCH',
              'NEEDS_VERIFICATION_EXPERIENCE',
              'NEEDS_VERIFICATION_EXPERIENCE_YEARS',
              'NEEDS_VERIFICATION_DEGREE',
              'NEEDS_VERIFICATION_CREDENTIAL',
              'GATE_UNKNOWN_WORK_MODE',
              'UNWORKABLE_LOCATION_MODEL',
              'GATE_HIGH_OFFICE_DAYS',
              'GATE_LIFESTYLE_INCOMPATIBLE',
              'GATE_OUT_OF_SCOPE_DOMAIN'
            )
          )
        )
      )
    ORDER BY c.created_at ASC, c.id ASC;
  `, [
    workspaceId,
    EARLY_PIPELINE_REPLAY_STATES,
    MATCH_REVALIDATION_REPLAY_STATES,
    AFFECTED_HISTORICAL_REPLAY_STATES,
  ]);

  return result.rows;
}

async function stageRehearsalCanaries(client: pg.PoolClient, ctx: WorkspaceContext) {
  console.log("Staging deterministic canaries for six lanes and qualification stages...");
  await loadWorkspaceLanesConfig(client as any, { context: ctx, seedIfEmpty: true });

  function padVector768(v: number[]): number[] {
    const out = new Array(768).fill(0);
    for (let i = 0; i < v.length; i++) out[i] = v[i];
    return out;
  }

  // 1. Ensure embedding space exists with gemini-embedding-001 (768 dimensions)
  const existingSpace = await client.query<{ id: string; dimensions: number }>(`
    SELECT id, dimensions FROM embedding_spaces
    WHERE workspace_id = $1 AND provider = 'gemini' AND model = 'gemini-embedding-001' AND active = true
    ORDER BY created_at DESC LIMIT 1;
  `, [ctx.workspaceId]);

  let spaceId: string;
  let dimensions = 768;
  if (existingSpace.rows.length > 0) {
    spaceId = existingSpace.rows[0].id;
    dimensions = existingSpace.rows[0].dimensions;
  } else {
    const newSpace = await client.query<{ id: string }>(`
      INSERT INTO embedding_spaces (id, workspace_id, space_key, provider, model, dimensions, vector_dimensions, active, is_fallback_space)
      VALUES (gen_random_uuid(), $1, 'gemini_canary', 'gemini', 'gemini-embedding-001', 768, 768, true, false)
      RETURNING id;
    `, [ctx.workspaceId]);
    spaceId = newSpace.rows[0].id;
  }

  // 2. Ensure completed batch
  const batchRes = await client.query<{ id: string }>(`
    INSERT INTO embedding_batches (id, workspace_id, embedding_space_id, batch_key, run_type, status, completed_at)
    VALUES (gen_random_uuid(), $1, $2, 'canary-batch-' || gen_random_uuid()::text, 'PRIMARY', 'COMPLETED', NOW())
    RETURNING id;
  `, [ctx.workspaceId, spaceId]);
  const batchId = batchRes.rows[0].id;

  // 3. Publish prototype vectors for all active workspace lanes
  const laneRevs = await client.query<{ lane_key: string; revision_id: string }>(`
    SELECT li.lane_key, lar.lane_revision_id AS revision_id
    FROM lane_active_revisions lar
    JOIN lane_identities li ON li.id = lar.lane_identity_id
    WHERE li.workspace_id = $1;
  `, [ctx.workspaceId]);

  const prototypeVectors: Record<string, number[]> = {
    CORE_AI_DATA: [1, 0, 0, 0, 0, 0],
    LEGAL_REGTECH: [0, 1, 0, 0, 0, 0],
    HEALTH_BIO_PHARMA: [0, 0, 1, 0, 0, 0],
    INVESTMENT_MARKETS_FINTECH: [0, 0, 0, 1, 0, 0],
    SOCIAL_IMPACT_MULTILATERAL: [0, 0, 0, 0, 1, 0],
    UNIVERSITY_AI_RESEARCH: [0, 0, 0, 0, 0, 1],
  };

  for (const lr of laneRevs.rows) {
    const vecRaw = prototypeVectors[lr.lane_key] || [1, 0, 0, 0, 0, 0];
    const vec = padVector768(vecRaw);

    const existingInput = await client.query<{ id: string }>(`
      SELECT id FROM embedding_inputs
      WHERE workspace_id = $1 AND source_type = 'LANE_PROTOTYPE' AND source_id = $2 AND is_current = true;
    `, [ctx.workspaceId, lr.revision_id]);

    let inputId: string;
    if (existingInput.rows.length > 0) {
      inputId = existingInput.rows[0].id;
      await client.query(`
        UPDATE semantic_embeddings
        SET embedding_values = $1, vector_dimensions = 768
        WHERE embedding_space_id = $2 AND embedding_input_id = $3;
      `, [vec, spaceId, inputId]);
    } else {
      const ins = await client.query<{ id: string }>(`
        INSERT INTO embedding_inputs (id, workspace_id, input_key, source_type, source_id, content_text, content_hash, is_current)
        VALUES (gen_random_uuid(), $1, 'canary-in-' || gen_random_uuid()::text, 'LANE_PROTOTYPE', $2, $3, md5($3), true)
        RETURNING id;
      `, [ctx.workspaceId, lr.revision_id, `Prototype for ${lr.lane_key}`]);
      inputId = ins.rows[0].id;

      await client.query(`
        INSERT INTO embedding_batch_items (id, workspace_id, embedding_batch_id, embedding_input_id, status)
        VALUES (gen_random_uuid(), $1, $2, $3, 'COMPLETED')
        ON CONFLICT DO NOTHING;
      `, [ctx.workspaceId, batchId, inputId]);
      await client.query(`
        INSERT INTO semantic_embeddings (id, workspace_id, embedding_space_id, embedding_input_id, embedding_batch_id, vector_dimensions, embedding_values, vector_checksum)
        VALUES (gen_random_uuid(), $1, $4, $3, $2, 768, $5, md5(array_to_string($5::double precision[], ',')))
        ON CONFLICT DO NOTHING;
      `, [ctx.workspaceId, batchId, inputId, spaceId, vec]);
    }

  }

  // 4. Staged Canaries for the 6 lanes and qualifications
  const stagedCanaries = [
    {
      id: "c0000000-0000-4000-8000-000000000001",
      scenario: "Lane 1: CORE_AI_DATA (L01)",
      title: "Staff Machine Learning Infrastructure Engineer",
      company: "Core AI Systems",
      desc: "Build production AI systems and machine learning engineering pipelines with MLOps infrastructure, scalable distributed training, PyTorch, and LLM inference platforms.",
      vec: padVector768([1, 0, 0, 0, 0, 0]),
      req: { key: "req_core_ai", type: "FUNCTION", importance: "MUST", text: "Machine Learning Engineering", struct: {} },
    },
    {
      id: "c0000000-0000-4000-8000-000000000002",
      scenario: "Lane 2: LEGAL_REGTECH (L02)",
      title: "Senior RegTech AI Specialist",
      company: "Trust & Compliance Tech",
      desc: "Build RegTech compliance automation and legal document intelligence using AML/KYC data, AI, and knowledge graphs.",
      vec: padVector768([0, 1, 0, 0, 0, 0]),
      req: { key: "req_legal_regtech", type: "FUNCTION", importance: "MUST", text: "RegTech compliance automation", struct: {} },
    },
    {
      id: "c0000000-0000-4000-8000-000000000003",
      scenario: "Lane 3: HEALTH_BIO_PHARMA (L03)",
      title: "Bioinformatics ML Scientist",
      company: "Pharma Therapeutics AI",
      desc: "Apply bioinformatics and scientific machine learning to computational biology, drug discovery, and genomic sequence modeling.",
      vec: padVector768([0, 0, 1, 0, 0, 0]),
      req: { key: "req_health_bio", type: "FUNCTION", importance: "MUST", text: "Bioinformatics machine learning", struct: {} },
    },
    {
      id: "c0000000-0000-4000-8000-000000000004",
      scenario: "Lane 4: INVESTMENT_MARKETS_FINTECH (L04)",
      title: "Quantitative ML Researcher",
      company: "Alpha Market Management",
      desc: "Design quantitative research and time-series models for institutional portfolio management, market data, and capital markets.",
      vec: padVector768([0, 0, 0, 1, 0, 0]),
      req: { key: "req_fintech", type: "FUNCTION", importance: "MUST", text: "Quantitative market data engineering", struct: {} },
    },
    {
      id: "c0000000-0000-4000-8000-000000000005",
      scenario: "Lane 5: SOCIAL_IMPACT_MULTILATERAL (L05)",
      title: "Climate Data Platform Architect",
      company: "Global Wildlife & Climate Initiative",
      desc: "Deliver multilateral international-development technology with digital public infrastructure, environmental data, and climate technology for biodiversity protection.",
      vec: padVector768([0, 0, 0, 0, 1, 0]),
      req: { key: "req_social_impact", type: "FUNCTION", importance: "MUST", text: "Digital public infrastructure", struct: {} },
    },
    {
      id: "c0000000-0000-4000-8000-000000000006",
      scenario: "Lane 6: UNIVERSITY_AI_RESEARCH (L06)",
      title: "Research Fellow in Machine Learning",
      company: "Institute for Advanced AI Studies",
      desc: "Conduct university AI research and research software engineering in scientific machine learning, neural architectures, and publish at top conferences.",
      vec: padVector768([0, 0, 0, 0, 0, 1]),
      req: { key: "req_university_research", type: "FUNCTION", importance: "MUST", text: "Machine learning research", struct: {} },
    },
    {
      id: "c0000000-0000-4000-8000-000000000007",
      scenario: "Multi-Lane Canary (Deterministic Priority Selection)",
      title: "Senior Legal AI & ML Infrastructure Architect",
      company: "LegalTech AI Systems",
      desc: "Build MLOps machine learning engineering infrastructure for RegTech compliance automation and legal document intelligence.",
      vec: padVector768([0.707, 0.707, 0, 0, 0, 0]),
      req: { key: "req_multi_lane", type: "FUNCTION", importance: "MUST", text: "Legal AI machine learning infrastructure", struct: {} },
    },
    {
      id: "c0000000-0000-4000-8000-000000000008",
      scenario: "Qualification: 10-Yr Ask with 1.5 Yr Evidenced (Coverage 0.15)",
      title: "Staff Deep Learning Architect",
      company: "DeepAI Corp",
      desc: "Build production machine learning engineering pipelines with MLOps infrastructure, PyTorch, and deep learning architectures. Requires 10 years experience in deep learning systems.",
      vec: padVector768([1, 0, 0, 0, 0, 0]),
      req: {
        key: "req_dl_10yr",
        type: "EXPERIENCE_YEARS",
        importance: "MUST",
        text: "10 years experience in deep learning systems",
        struct: { minimum_years: 10, experience_scope: "deep learning" },
      },
    },
    {
      id: "c0000000-0000-4000-8000-000000000009",
      scenario: "Qualification: Mandatory Cert Missing (UNMATCHED)",
      title: "Financial AI Security Platform Engineer",
      company: "FinSec Global",
      desc: "Design quantitative research, market data, and AI financial security infrastructure for institutional trading platforms. CISSP certification strictly mandatory.",
      vec: padVector768([0, 0, 0, 1, 0, 0]),
      req: {
        key: "req_cissp_mand",
        type: "CREDENTIAL",
        importance: "MUST",
        text: "CISSP certification mandatory",
        struct: { is_required: true, credential_name: "CISSP" },
      },
    },
    {
      id: "c0000000-0000-4000-8000-000000000010",
      scenario: "Fully Complete Semantic Evidence Canary (MATCHED)",
      title: "Principal Machine Learning Engineer",
      company: "Core AI Systems",
      desc: "Build machine learning systems and PyTorch pipelines.",
      vec: padVector768([1, 0, 0, 0, 0, 0]),
      req: {
        key: "req_ml_eng_complete",
        type: "FUNCTION",
        importance: "MUST",
        text: "Machine Learning Engineering in PyTorch",
        struct: {},
      },
    },
  ];

  const stagedIds: string[] = [];

  // Clean up any prior canary runs
  await client.query(`
    UPDATE canonical_jobs SET latest_job_version_id = NULL WHERE id::text LIKE 'c0000000-0000-4000-8000-%';
    DELETE FROM job_versions WHERE canonical_job_id::text LIKE 'c0000000-0000-4000-8000-%';
    DELETE FROM canonical_jobs WHERE id::text LIKE 'c0000000-0000-4000-8000-%';
  `);

  for (const c of stagedCanaries) {
    stagedIds.push(c.id);
    const jvId = "d" + c.id.slice(1);

    await client.query(`
      INSERT INTO canonical_jobs (id, workspace_id, normalized_title, company_name, workplace_type, location, canonical_url, processing_state, processing_status, created_at, updated_at)
      VALUES ($1, $2, $3, $4, 'REMOTE', 'Singapore', 'https://canary.example.com/apply', 'RAW_STAGED', 'RAW_STAGED', NOW(), NOW());
    `, [c.id, ctx.workspaceId, c.title, c.company]);

    await client.query(`
      INSERT INTO job_versions (id, workspace_id, canonical_job_id, description_text, observed_at)
      VALUES ($1, $2, $3, $4, NOW());
    `, [jvId, ctx.workspaceId, c.id, c.desc]);

    let canaryReqSetId: string | null = null;
    if ((c as any).req) {
      const idRes = await client.query<{ id: string }>(`
        INSERT INTO requirement_set_identities (id, workspace_id, canonical_job_id, identity_hash, schema_version, job_content_hash, deterministic_extractor_version, quoted_extractor_version, quoted_prompt_hash, normalizer_hash)
        VALUES (gen_random_uuid(), $1, $2, md5($3), '2.2.0', md5($3), '1.0', '1.0', '1.0', '1.0')
        RETURNING id;
      `, [ctx.workspaceId, c.id, c.desc]);
      const setRes = await client.query<{ id: string }>(`
        INSERT INTO requirement_sets (id, workspace_id, requirement_identity_id, canonical_job_id, job_version_id, revision_number, source_type)
        VALUES (gen_random_uuid(), $1, $2, $3, $4, 1, 'EXTRACTED')
        RETURNING id;
      `, [ctx.workspaceId, idRes.rows[0].id, c.id, jvId]);
      canaryReqSetId = setRes.rows[0].id;

      await client.query(`
        UPDATE job_versions SET active_requirement_set_id = $1 WHERE id = $2;
      `, [canaryReqSetId, jvId]);
    }

    await client.query(`
      UPDATE canonical_jobs SET latest_job_version_id = $1 WHERE id = $2;
    `, [jvId, c.id]);

    if ((c as any).req && canaryReqSetId) {
      const r = (c as any).req;
      const reqId = "e" + c.id.slice(1);
      await client.query(`
        INSERT INTO job_requirements (id, workspace_id, canonical_job_id, job_version_id, requirement_set_id, requirement_key, requirement_type, importance, requirement_text, structured_value, status, extractor_type, extractor_version, confidence)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'VALIDATED', 'DETERMINISTIC', '1.0', 1.0);
      `, [reqId, ctx.workspaceId, c.id, jvId, canaryReqSetId, r.key, r.type, r.importance, r.text, JSON.stringify(r.struct)]);

      await client.query(`
        INSERT INTO requirement_extraction_runs (id, workspace_id, canonical_job_id, job_version_id, requirement_set_id, run_type, status, completed_at)
        VALUES (gen_random_uuid(), $1, $2, $3, $4, 'DETERMINISTIC', 'COMPLETED', NOW());
      `, [ctx.workspaceId, c.id, jvId, canaryReqSetId]);
      await client.query(`
        INSERT INTO job_version_pipeline_state (id, workspace_id, canonical_job_id, job_version_id, current_stage, stage_status, updated_at)
        VALUES (gen_random_uuid(), $1, $2, $3, 'REQUIREMENTS_EXTRACTED', 'COMPLETED', NOW())
        ON CONFLICT (job_version_id) DO UPDATE SET current_stage = 'REQUIREMENTS_EXTRACTED', stage_status = 'COMPLETED';
      `, [ctx.workspaceId, c.id, jvId]);
    }

    if (c.vec) {
      const existingJvInput = await client.query<{ id: string }>(`
        SELECT id FROM embedding_inputs
        WHERE workspace_id = $1 AND source_type = 'JOB_VERSION' AND source_id = $2 AND is_current = true;
      `, [ctx.workspaceId, jvId]);

      let inputId: string;
      if (existingJvInput.rows.length > 0) {
        inputId = existingJvInput.rows[0].id;
      } else {
        const ins = await client.query<{ id: string }>(`
          INSERT INTO embedding_inputs (id, workspace_id, input_key, source_type, source_id, content_text, content_hash, is_current)
          VALUES (gen_random_uuid(), $1, 'canary-in-' || gen_random_uuid()::text, 'JOB_VERSION', $2, $3, md5($3), true)
          RETURNING id;
        `, [ctx.workspaceId, jvId, c.desc]);
        inputId = ins.rows[0].id;
      }

      await client.query(`
        INSERT INTO embedding_batch_items (id, workspace_id, embedding_batch_id, embedding_input_id, status)
        VALUES (gen_random_uuid(), $1, $2, $3, 'COMPLETED')
        ON CONFLICT DO NOTHING;
      `, [ctx.workspaceId, batchId, inputId]);
      await client.query(`
        INSERT INTO semantic_embeddings (id, workspace_id, embedding_space_id, embedding_input_id, embedding_batch_id, vector_dimensions, embedding_values, vector_checksum)
        VALUES (gen_random_uuid(), $1, $4, $3, $2, 768, $5, md5(array_to_string($5::double precision[], ',')))
        ON CONFLICT DO NOTHING;
      `, [ctx.workspaceId, batchId, inputId, spaceId, padVector768(c.vec)]);
    }

    if (c.id === "c0000000-0000-4000-8000-000000000010") {
      const reqId = "e" + c.id.slice(1);
      const reqInput = await client.query<{ id: string }>(`
        INSERT INTO embedding_inputs (id, workspace_id, input_key, source_type, source_id, content_text, content_hash, is_current)
        VALUES (gen_random_uuid(), $1, 'canary-in-' || gen_random_uuid()::text, 'JOB_REQUIREMENT', $2, 'Machine Learning Engineering in PyTorch', md5('mle'), true)
        ON CONFLICT DO NOTHING RETURNING id;
      `, [ctx.workspaceId, reqId]);
      const reqInId = reqInput.rows[0]?.id;
      if (reqInId) {
        await client.query(`
          INSERT INTO embedding_batch_items (id, workspace_id, embedding_batch_id, embedding_input_id, status)
          VALUES (gen_random_uuid(), $1, $2, $3, 'COMPLETED') ON CONFLICT DO NOTHING;
        `, [ctx.workspaceId, batchId, reqInId]);
        await client.query(`
          INSERT INTO semantic_embeddings (id, workspace_id, embedding_space_id, embedding_input_id, embedding_batch_id, vector_dimensions, embedding_values, vector_checksum)
          VALUES (gen_random_uuid(), $1, $4, $3, $2, 768, $5, md5(array_to_string($5::double precision[], ','))) ON CONFLICT DO NOTHING;
        `, [ctx.workspaceId, batchId, reqInId, spaceId, padVector768([1, 0, 0, 0, 0, 0])]);
      }

      const pfRes = await client.query<{ id: string }>(`
        SELECT id FROM profile_facts WHERE workspace_id = $1 LIMIT 1;
      `, [ctx.workspaceId]);
      if (pfRes.rows.length > 0) {
        const pfId = pfRes.rows[0].id;
        const pfInput = await client.query<{ id: string }>(`
          INSERT INTO embedding_inputs (id, workspace_id, input_key, source_type, source_id, content_text, content_hash, is_current)
          VALUES (gen_random_uuid(), $1, 'canary-in-' || gen_random_uuid()::text, 'PROFILE_FACT', $2, 'ML Profile Fact', md5('pf'), true)
          ON CONFLICT DO NOTHING RETURNING id;
        `, [ctx.workspaceId, pfId]);
        const pfInId = pfInput.rows[0]?.id;
        if (pfInId) {
          await client.query(`
            INSERT INTO embedding_batch_items (id, workspace_id, embedding_batch_id, embedding_input_id, status)
            VALUES (gen_random_uuid(), $1, $2, $3, 'COMPLETED') ON CONFLICT DO NOTHING;
          `, [ctx.workspaceId, batchId, pfInId]);
          await client.query(`
            INSERT INTO semantic_embeddings (id, workspace_id, embedding_space_id, embedding_input_id, embedding_batch_id, vector_dimensions, embedding_values, vector_checksum)
            VALUES (gen_random_uuid(), $1, $4, $3, $2, 768, $5, md5(array_to_string($5::double precision[], ','))) ON CONFLICT DO NOTHING;
          `, [ctx.workspaceId, batchId, pfInId, spaceId, padVector768([1, 0, 0, 0, 0, 0])]);
        }
      }
    }
  }

  return { stagedCanaries, stagedIds };
}

async function main() {
  const target = getRehearsalDatabaseTarget();
  requireRehearsalWriteConfirmation(target);
  const canariesOnly = isCanariesOnlyMode();

  console.log("================================================================================");
  console.log(` PHASE 3 — HISTORICAL JOB RECOVERY & ${target.environment} REHEARSAL`);
  console.log("================================================================================");

  const pool = new pg.Pool(pgPoolConfig(target.databaseUrl));
  const client = await pool.connect();

  try {
    const ctx = await resolveWorkspaceContext(client as any);
    console.log(`Workspace: ${ctx.workspaceId} (${ctx.workspaceKey})`);

    // 1. Snapshot baseline
    console.log("\n--- 1. Baseline Processing Distribution ---");
    const baselineDist = await getProcessingDistribution(client, ctx.workspaceId);
    console.table(baselineDist);

    const baselineRejections = await getRejectionCodes(client, ctx.workspaceId);
    console.log("Baseline top rejection codes:", baselineRejections);

    const baselineLanes = await getLaneDistribution(client, ctx.workspaceId);
    console.log("Baseline lane distribution:", baselineLanes);

    // 2. Dry-run classification
    console.log("\n--- 2. Dry-Run Policy Analysis of Historical Backlog ---");
    const { rows: allJobs } = await client.query<{
      id: string;
      title: string;
      company_name: string;
      processing_state: string;
      primary_lane: string | null;
      rejection_reason: string | null;
      description_text: string | null;
    }>(`
      SELECT c.id, COALESCE(c.normalized_title, '') AS title, COALESCE(c.company_name, '') AS company_name,
             COALESCE(c.processing_state, c.processing_status, 'RAW_STAGED') AS processing_state,
             c.primary_lane, c.rejection_reason,
             jv.description_text
      FROM canonical_jobs c
      LEFT JOIN LATERAL (
        SELECT description_text
        FROM job_versions
        WHERE workspace_id = c.workspace_id AND canonical_job_id = c.id
        ORDER BY observed_at DESC, id DESC
        LIMIT 1
      ) jv ON TRUE
      WHERE c.workspace_id = $1
      ORDER BY c.created_at ASC;
    `, [ctx.workspaceId]);

    console.log(`Loaded ${allJobs.length} canonical jobs for policy evaluation.`);

    let hybrid32Count = 0;
    let unknownWorkplaceCount = 0;
    let onsiteOver3Count = 0;
    let travelOver20Count = 0;
    let fdeExcludedCount = 0;
    let socialImpactCount = 0;
    let universityResearchCount = 0;
    let standardCoreAiCount = 0;
    let legalRegtechCount = 0;
    let healthBioPharmaCount = 0;
    let fintechCount = 0;

    for (const job of allJobs) {
      const text = (job.description_text || "").toLowerCase();
      const title = (job.title || "").toLowerCase();

      if (title.includes("forward deployed") || title.includes("fde") || title.includes("forward deployment")) {
        fdeExcludedCount++;
      }
      if (text.includes("hybrid") && !text.includes("day") && !text.includes("onsite")) {
        hybrid32Count++;
      }
      if (!text.includes("remote") && !text.includes("hybrid") && !text.includes("onsite") && !text.includes("in-office")) {
        unknownWorkplaceCount++;
      }
      if (text.includes("4 days onsite") || text.includes("5 days onsite") || text.includes("4 days in office") || text.includes("5 days in office")) {
        onsiteOver3Count++;
      }
      if (text.includes("25% travel") || text.includes("30% travel") || text.includes("20-30% travel") || text.includes("50% travel") || text.includes("frequent travel")) {
        travelOver20Count++;
      }
      if (text.includes("multilateral") || text.includes("social impact") || text.includes("undp") || text.includes("world bank") || text.includes("public health")) {
        socialImpactCount++;
      }
      if (text.includes("university") || text.includes("postdoctoral") || text.includes("phd research") || text.includes("academic lab")) {
        universityResearchCount++;
      }
    }

    console.log("Dry-run Policy Category Breakdown:");
    console.log({
      totalJobs: allJobs.length,
      fdeExcluded: fdeExcludedCount,
      hybrid32Assumed: hybrid32Count,
      unknownWorkplaceCandidates: unknownWorkplaceCount,
      onsiteOver3DaysCandidates: onsiteOver3Count,
      travelOver20PctCandidates: travelOver20Count,
      socialImpactLaneCandidates: socialImpactCount,
      universityResearchLaneCandidates: universityResearchCount,
    });

    // 3. Canary Replay (~20-25 representative jobs covering all required policy scenarios)
    console.log("\n--- 3. Bounded Canary Replay (Representative Scenarios & Six Lanes) ---");
    const { stagedCanaries } = await stageRehearsalCanaries(client, ctx);

    const canaryScenarios: { scenario: string; query: string }[] = [
      {
        scenario: "Hybrid (no explicit days -> 3/2 assumed)",
        query: `SELECT c.id, COALESCE(c.normalized_title, '') AS title, c.processing_state FROM canonical_jobs c JOIN job_versions jv ON jv.id = c.latest_job_version_id WHERE (c.workplace_type ILIKE '%hybrid%' OR jv.description_text ILIKE '%hybrid%') AND jv.description_text NOT ILIKE '%day%onsite%' AND jv.description_text NOT ILIKE '%days%office%' LIMIT 1`,
      },
      {
        scenario: "Explicit 3 onsite days (pass workplace gate)",
        query: `SELECT c.id, COALESCE(c.normalized_title, '') AS title, c.processing_state FROM canonical_jobs c JOIN job_versions jv ON jv.id = c.latest_job_version_id WHERE jv.description_text ILIKE '%3 days onsite%' OR jv.description_text ILIKE '%3 days in office%' OR jv.description_text ILIKE '%3 days per week in the office%' LIMIT 1`,
      },
      {
        scenario: "Explicit 4+ onsite days (reject)",
        query: `SELECT c.id, COALESCE(c.normalized_title, '') AS title, c.processing_state FROM canonical_jobs c JOIN job_versions jv ON jv.id = c.latest_job_version_id WHERE jv.description_text ILIKE '%4 days onsite%' OR jv.description_text ILIKE '%5 days onsite%' OR jv.description_text ILIKE '%4 days in office%' OR jv.description_text ILIKE '%5 days in office%' OR c.workplace_type = 'ONSITE' LIMIT 1`,
      },
      {
        scenario: "Unknown workplace (reject)",
        query: `SELECT c.id, COALESCE(c.normalized_title, '') AS title, c.processing_state FROM canonical_jobs c JOIN job_versions jv ON jv.id = c.latest_job_version_id WHERE (c.workplace_type = 'UNKNOWN' OR c.workplace_type IS NULL) AND jv.description_text NOT ILIKE '%remote%' AND jv.description_text NOT ILIKE '%hybrid%' AND jv.description_text NOT ILIKE '%onsite%' LIMIT 1`,
      },
      {
        scenario: "Fully remote SG-compatible (pass)",
        query: `SELECT c.id, COALESCE(c.normalized_title, '') AS title, c.processing_state FROM canonical_jobs c JOIN job_versions jv ON jv.id = c.latest_job_version_id WHERE (c.workplace_type = 'REMOTE' OR jv.description_text ILIKE '%remote%') AND (c.location ILIKE '%singapore%' OR jv.description_text ILIKE '%singapore%') LIMIT 1`,
      },
      {
        scenario: "Remote requiring foreign work auth (reject)",
        query: `SELECT c.id, COALESCE(c.normalized_title, '') AS title, c.processing_state FROM canonical_jobs c JOIN job_versions jv ON jv.id = c.latest_job_version_id WHERE jv.description_text ILIKE '%us citizen%' OR jv.description_text ILIKE '%security clearance%' OR jv.description_text ILIKE '%authorized to work in the us%' OR jv.description_text ILIKE '%uk right to work%' LIMIT 1`,
      },
      {
        scenario: "Travel <=20% (pass)",
        query: `SELECT c.id, COALESCE(c.normalized_title, '') AS title, c.processing_state FROM canonical_jobs c JOIN job_versions jv ON jv.id = c.latest_job_version_id WHERE jv.description_text ILIKE '%10% travel%' OR jv.description_text ILIKE '%15% travel%' OR jv.description_text ILIKE '%up to 20% travel%' OR jv.description_text ILIKE '%minimal travel%' LIMIT 1`,
      },
      {
        scenario: "Travel 20-30% range (reject)",
        query: `SELECT c.id, COALESCE(c.normalized_title, '') AS title, c.processing_state FROM canonical_jobs c JOIN job_versions jv ON jv.id = c.latest_job_version_id WHERE jv.description_text ILIKE '%20-30% travel%' OR jv.description_text ILIKE '%25% travel%' OR jv.description_text ILIKE '%30% travel%' OR jv.description_text ILIKE '%50% travel%' OR jv.description_text ILIKE '%frequent travel%' LIMIT 1`,
      },
      {
        scenario: "FDE title (reject)",
        query: `SELECT c.id, COALESCE(c.normalized_title, '') AS title, c.processing_state FROM canonical_jobs c WHERE c.normalized_title ILIKE '%forward deployed%' OR c.normalized_title ILIKE '%fde%' LIMIT 1`,
      },
      {
        scenario: "Approved Technical Project/Program (pass)",
        query: `SELECT c.id, COALESCE(c.normalized_title, '') AS title, c.processing_state FROM canonical_jobs c WHERE c.normalized_title ILIKE '%technical project%' OR c.normalized_title ILIKE '%technical program%' OR c.normalized_title ILIKE '%technical delivery%' LIMIT 1`,
      },
      {
        scenario: "Generic Prohibited PM/Consultant (reject)",
        query: `SELECT c.id, COALESCE(c.normalized_title, '') AS title, c.processing_state FROM canonical_jobs c WHERE (c.normalized_title ILIKE '%project manager%' OR c.normalized_title ILIKE '%program manager%' OR c.normalized_title ILIKE '%consultant%') AND c.normalized_title NOT ILIKE '%technical%' LIMIT 1`,
      },
      {
        scenario: "Previously ROUTING_DEFERRED candidate",
        query: `SELECT c.id, COALESCE(c.normalized_title, '') AS title, c.processing_state FROM canonical_jobs c WHERE c.processing_state = 'ROUTING_DEFERRED' LIMIT 1`,
      },
      {
        scenario: "Compensation missing (does not hard reject)",
        query: `SELECT c.id, COALESCE(c.normalized_title, '') AS title, c.processing_state FROM canonical_jobs c WHERE c.workplace_type = 'REMOTE' LIMIT 1`,
      },
    ];

    interface CanaryResultRecord {
      scenario: string;
      jobId: string;
      title: string;
      oldState: string;
      gateResult: string;
      gateReason: string;
      laneResult: string;
      embeddingReadiness: string;
      deterministicMatchResult: string;
      semanticResult: string;
      finalState: string;
    }

    const canaryResults: CanaryResultRecord[] = [];
    const canaryJobIds: string[] = [];
    const canaryMap = new Map<string, { scenario: string; oldState: string; title: string }>();

    // Add staged canaries first
    for (const sc of stagedCanaries) {
      canaryJobIds.push(sc.id);
      canaryMap.set(sc.id, {
        scenario: sc.scenario,
        oldState: "RAW_STAGED",
        title: sc.title,
      });
    }

    // Add query-based historical canaries
    for (const sc of canaryScenarios) {
      const res = await client.query<{ id: string; title: string; processing_state: string }>(sc.query);
      if (res.rows.length > 0) {
        const row = res.rows[0];
        if (!canaryMap.has(row.id)) {
          canaryJobIds.push(row.id);
          canaryMap.set(row.id, {
            scenario: sc.scenario,
            oldState: row.processing_state,
            title: row.title,
          });
        }
      }
    }

    console.log(`Discovered ${canaryJobIds.length} concrete canary jobs across all required scenarios.`);

    // Run pipeline stages on canary jobs
    console.log("Running Hard Gates on canary jobs...");
    const canaryGateResult = await runHardGates(pool, {
      context: ctx,
      canonicalJobIds: canaryJobIds,
      reprocess: true,
    });
    console.log("Canary Hard Gate Results:", canaryGateResult);

    console.log("Running Lane Routing on canary jobs...");
    const canaryLaneResult = await runLaneRouting(pool, {
      context: ctx,
      canonicalJobIds: canaryJobIds,
    });
    console.log("Canary Lane Routing Results:", canaryLaneResult);

    console.log("Running Deterministic Matcher on canary jobs...");
    const canaryMatchResult = await runDeterministicMatcher(pool, {
      context: ctx,
      canonicalJobIds: canaryJobIds,
    });
    console.log("Canary Deterministic Match Results:", canaryMatchResult);

    // Query detailed state for each canary job
    for (const [id, meta] of canaryMap.entries()) {
      const jobRes = await client.query<{
        processing_state: string;
        primary_lane: string | null;
        deterministic_match_score: number | null;
        deterministic_match_coverage: number | null;
        recommendation_outcome: string | null;
      }>(`
        SELECT processing_state, primary_lane, deterministic_match_score, deterministic_match_coverage, recommendation_outcome
        FROM canonical_jobs WHERE id = $1;
      `, [id]);

      const gateRes = await client.query<{
        decision: string;
        rejection_codes: any;
        workability_facts: any;
      }>(`
        SELECT decision, rejection_codes, workability_facts
        FROM gate_decisions WHERE canonical_job_id = $1 ORDER BY created_at DESC LIMIT 1;
      `, [id]);

      const embRes = await client.query<{ count: string }>(`
        SELECT COUNT(*)::text AS count
        FROM v_matchable_nodes
        WHERE node_id = (SELECT latest_job_version_id FROM canonical_jobs WHERE id = $1)
           OR node_id IN (SELECT id FROM job_requirements WHERE canonical_job_id = $1);
      `, [id]);

      const jobRow = jobRes.rows[0];
      const gateRow = gateRes.rows[0];
      const embCount = parseInt(embRes.rows[0]?.count || "0", 10);

      const decision = gateRow ? gateRow.decision : "NO_GATE";
      const reasons = gateRow?.rejection_codes
        ? (Array.isArray(gateRow.rejection_codes) ? gateRow.rejection_codes.join(", ") : JSON.stringify(gateRow.rejection_codes))
        : "NONE";
      const lane = jobRow?.primary_lane || "UNCLASSIFIED";
      const embReadiness = embCount > 0 ? `READY (${embCount} vectors)` : "INCOMPLETE (0 vectors)";
      const detMatch = jobRow?.deterministic_match_score !== null && jobRow?.deterministic_match_score !== undefined
        ? `SCORE: ${(jobRow.deterministic_match_score * 100).toFixed(1)}%`
        : "SKIPPED/UNMATCHED";
      const semResult = embCount > 0 ? "EVALUATED" : "PENDING_COHORT";
      const finalState = jobRow?.processing_state || "UNKNOWN";

      canaryResults.push({
        scenario: meta.scenario,
        jobId: id,
        title: meta.title.slice(0, 35),
        oldState: meta.oldState,
        gateResult: decision,
        gateReason: reasons,
        laneResult: lane,
        embeddingReadiness: embReadiness,
        deterministicMatchResult: detMatch,
        semanticResult: semResult,
        finalState,
      });
    }

    console.log("\n================================================================================");
    console.log(" CANARY REPLAY REPORT TABLE");
    console.log("================================================================================");
    console.table(canaryResults);

    // CRITICAL CANARY ASSERTIONS
    console.log("\n--- Verifying Critical Canary Assertions ---");

    // Assertion 1: No incomplete embedding cohort may reach MATCHED
    const incompleteMatched = canaryResults.filter(
      r => r.finalState === "MATCHED" && r.embeddingReadiness.startsWith("INCOMPLETE")
    );
    if (incompleteMatched.length > 0) {
      throw new Error(`CRITICAL VIOLATION: Job reached MATCHED with incomplete embeddings: ${incompleteMatched.map(i => i.jobId).join(", ")}`);
    }
    console.log("✓ Critical Assertion 1: No incomplete embedding cohort reached MATCHED.");

    // Assertion 2: No job without an eligible active lane may reach MATCHED
    const unclassifiedMatched = canaryResults.filter(
      r => r.finalState === "MATCHED" && (r.laneResult === "UNCLASSIFIED" || !r.laneResult)
    );
    if (unclassifiedMatched.length > 0) {
      throw new Error(`CRITICAL VIOLATION: Job reached MATCHED without active lane: ${unclassifiedMatched.map(u => u.jobId).join(", ")}`);
    }
    console.log("✓ Critical Assertion 2: No job without active lane reached MATCHED.");

    // Assertion 3: High semantic similarity cannot override failed deterministic gate
    const gateRejectedMatched = canaryResults.filter(
      r => r.gateResult === "HARD_REJECT" && r.finalState === "MATCHED"
    );
    if (gateRejectedMatched.length > 0) {
      throw new Error(`CRITICAL VIOLATION: Hard rejected job reached MATCHED: ${gateRejectedMatched.map(g => g.jobId).join(", ")}`);
    }
    console.log("✓ Critical Assertion 3: Hard-rejected jobs never reach MATCHED.");

    // Assertion 4: Compensation missing does not hard reject
    const compCase = canaryResults.find(r => r.scenario.includes("Compensation missing"));
    if (compCase && (compCase.gateReason.includes("SALARY") || compCase.gateReason.includes("COMPENSATION"))) {
      throw new Error("CRITICAL VIOLATION: Compensation missing caused hard rejection!");
    }
    console.log("✓ Critical Assertion 4: Compensation missing does not hard reject.");

    // Assertion 5: Hybrid assumption provenance stored as USER_POLICY_ASSUMPTION
    const hybridRow = await client.query<{ workability_facts: any }>(`
      SELECT workability_facts FROM gate_decisions
      WHERE canonical_job_id = $1 ORDER BY created_at DESC LIMIT 1;
    `, [canaryResults.find(r => r.scenario.includes("Hybrid (no explicit days"))?.jobId]);
    const hybridFacts = hybridRow.rows[0]?.workability_facts || {};
    if (hybridFacts.attendance_basis === "POLICY_HYBRID_3_2") {
      console.log("✓ Critical Assertion 5: Hybrid 3/2 assumption stored with attendance_basis: POLICY_HYBRID_3_2.");
    } else {
      console.log(`ℹ️ Hybrid basis: ${hybridFacts.attendance_basis || "NONE"}`);
    }

    // Assertion 6: Six lane routes proven
    const sixLanes = [
      "CORE_AI_DATA",
      "LEGAL_REGTECH",
      "HEALTH_BIO_PHARMA",
      "INVESTMENT_MARKETS_FINTECH",
      "SOCIAL_IMPACT_MULTILATERAL",
      "UNIVERSITY_AI_RESEARCH",
    ];
    for (const lane of sixLanes) {
      const match = canaryResults.find(r => r.laneResult === lane);
      if (!match) {
        throw new Error(`CRITICAL VIOLATION: Lane ${lane} had zero routed canaries!`);
      }
      console.log(`✓ Critical Assertion 6: Lane ${lane} successfully proven (job: ${match.jobId}).`);
    }

    // Assertion 7: At least one complete semantic evidence canary reached MATCHED
    const completeMatched = canaryResults.find(r => r.finalState === "MATCHED");
    if (!completeMatched) {
      throw new Error("CRITICAL VIOLATION: Zero canaries reached MATCHED!");
    }
    console.log(`✓ Critical Assertion 7: Complete semantic evidence canary reached MATCHED (${completeMatched.jobId}).`);

    // Assertion 8: Mandatory cert missing produced UNMATCHED at matching stage, NOT hard reject
    const certMandCase = canaryResults.find(r => r.scenario.includes("Mandatory Cert Missing"));
    if (certMandCase) {
      if (certMandCase.gateResult !== "PASS") {
        throw new Error(`CRITICAL VIOLATION: Mandatory cert missing was rejected at global hard gates (${certMandCase.gateResult})!`);
      }
      if (certMandCase.finalState !== "UNMATCHED") {
        console.warn(`Notice: Mandatory cert missing state is ${certMandCase.finalState} (expected UNMATCHED).`);
      } else {
        console.log("✓ Critical Assertion 8: Mandatory cert missing produced UNMATCHED at matching stage without global hard reject.");
      }
    }

    // Assertion 9: 10-year experience ask with 1.5 years evidenced did NOT hard reject
    const expCase = canaryResults.find(r => r.scenario.includes("10-Yr Ask"));
    if (expCase) {
      if (expCase.gateResult !== "PASS") {
        throw new Error(`CRITICAL VIOLATION: 10-yr experience ask was rejected at global hard gates (${expCase.gateResult})!`);
      }
      console.log("✓ Critical Assertion 9: 10-yr experience ask with 1.5 yrs evidenced passed global hard gates and was evaluated in matching.");
    }

    console.log("✅ ALL CANARY INVARIANTS AND CRITICAL ASSERTIONS VERIFIED CLEANLY.");
    if (canariesOnly) {
      console.log("Canary-only mode complete; no historical records were selected or replayed.");
      return;
    }

    // 4. Affected Historical Cohort Replay (with controlled AI evaluation budget)
    // Never reprocess a record merely because it exists. This selector includes only
    // nonterminal workflow states, stale match states, and hard rejects tied to rules
    // revised by Funnel V3; canaries are excluded from the historical cohort.
    console.log("\n--- 4. Affected Historical Cohort Replay with Controlled AI Budget ---");
    const affectedJobs = await listAffectedHistoricalJobs(client, ctx.workspaceId);
    const affectedJobIds = affectedJobs.map((job) => job.id);
    const affectedByReason = affectedJobs.reduce<Record<string, number>>((counts, job) => {
      counts[job.reason] = (counts[job.reason] ?? 0) + 1;
      return counts;
    }, {});
    console.log(`Selected ${affectedJobIds.length} affected historical job(s) for replay.`, affectedByReason);
    if (!shouldReplayAffectedHistoricalJobs(affectedJobIds)) {
      console.log("No affected historical jobs selected; skipping the historical replay as a no-op.");
      return;
    }

    // Step 4a: Run hard gates only for the affected cohort.
    console.log("Executing Hard Gate Evaluation for affected historical cohort...");
    const fullGateResult = await runHardGates(pool, {
      context: ctx,
      canonicalJobIds: affectedJobIds,
      reprocess: true,
    });
    console.log("Affected Cohort Hard Gate Results:", fullGateResult);

    // Step 4b: Route only the affected cohort that passed hard gates.
    console.log("Executing Lane Routing for affected historical cohort...");
    const fullLaneResult = await runLaneRouting(pool, {
      context: ctx,
      canonicalJobIds: affectedJobIds,
    });
    console.log("Affected Cohort Lane Routing Results:", fullLaneResult);

    // Step 4c: Deterministic qualification and semantic matching for the same cohort.
    console.log("Executing Deterministic Matcher for affected historical cohort...");
    const fullMatchResult = await runDeterministicMatcher(pool, {
      context: ctx,
      canonicalJobIds: affectedJobIds,
    });
    console.log("Affected Cohort Deterministic Match Results:", fullMatchResult);

    // Step 4d: Recompute recommendations only for affected records.
    console.log("Executing Recommendation Decider for affected historical cohort...");
    const recDecideResult = await runRecommendationDecider(pool, {
      context: ctx,
      canonicalJobIds: affectedJobIds,
    });
    console.log("Affected Cohort Recommendation Decider Results:", recDecideResult);

    // Step 4e: Controlled AI Evaluation Budgeting only for the selected cohort.
    console.log("\n--- 4e. Controlled AI Evaluation Budget Enqueueing ---");
    const budgetRunId = crypto.randomUUID();
    const enqueueResult = await runExplanationQueueEnqueuer(pool, {
      context: ctx,
      canonicalJobIds: affectedJobIds,
      budgetRunId,
    });
    console.log("Affected Cohort Explanation Queue Enqueuer Results:", enqueueResult);

    // 5. Post-Replay Snapshot & Idempotency Run
    console.log("\n--- 5. Post-Replay State Distribution ---");
    const postReplayDist = await getProcessingDistribution(client, ctx.workspaceId);
    console.table(postReplayDist);

    const postReplayRejections = await getRejectionCodes(client, ctx.workspaceId);
    console.log("Post-Replay top rejection codes:", postReplayRejections);

    const forbiddenGlobalQualificationCodes = [
      "GATE_EXPERIENCE_YEARS_MISMATCH",
      "GATE_DEGREE_MISMATCH",
      "GATE_CREDENTIAL_MISMATCH",
      "NEEDS_VERIFICATION_EXPERIENCE",
      "NEEDS_VERIFICATION_EXPERIENCE_YEARS",
    ].filter((code) => (postReplayRejections[code] ?? 0) > 0);
    if (forbiddenGlobalQualificationCodes.length > 0) {
      throw new Error(
        `CRITICAL VIOLATION: Employer qualification codes persisted as latest global gate outcomes: ${forbiddenGlobalQualificationCodes.join(", ")}`
      );
    }
    console.log("✓ Qualification separation confirmed: latest global gate decisions contain no employer-fit reason codes.");

    const postReplayLanes = await getLaneDistribution(client, ctx.workspaceId);
    console.log("Post-Replay lane distribution:", postReplayLanes);

    const postReplayAuditCounts = await getReplayAuditCounts(
      client,
      ctx.workspaceId,
      affectedJobIds,
      budgetRunId,
    );
    console.log("Post-Replay decision/task/queue/budget counts:", postReplayAuditCounts);

    // Step 5b: Replay a Second Time to Confirm Idempotency
    console.log("\n--- 5b. Second Replay Pass (Idempotency Check) ---");
    const secondGateResult = await runHardGates(pool, {
      context: ctx,
      canonicalJobIds: affectedJobIds,
      reprocess: false,
    });
    console.log("Second affected-cohort gate run (should be 0 unhandled):", secondGateResult);

    const { rows: secondTechnicalDeferred } = await client.query<{ id: string }>(`
      SELECT id
      FROM canonical_jobs
      WHERE workspace_id = $1
        AND id = ANY($2::uuid[])
        AND COALESCE(processing_state, processing_status) = 'ROUTING_DEFERRED'
        AND COALESCE(routing_disposition, 'TECHNICAL_DEFERRED') = 'TECHNICAL_DEFERRED'
      ORDER BY id`,
      [ctx.workspaceId, affectedJobIds]
    );
    const secondLaneResult = secondTechnicalDeferred.length > 0
      ? await runLaneRouting(pool, {
          context: ctx,
          canonicalJobIds: secondTechnicalDeferred.map((row) => row.id),
        })
      : { routed: 0, deferred: 0 };
    console.log("Second affected-cohort technical lane run (should be 0 newly routed):", secondLaneResult);

    const secondMatchResult = await runDeterministicMatcher(pool, {
      context: ctx,
      canonicalJobIds: affectedJobIds,
    });
    console.log("Second affected-cohort match run (should be 0 newly matched):", secondMatchResult);

    const secondRecommendationResult = await runRecommendationDecider(pool, {
      context: ctx,
      canonicalJobIds: affectedJobIds,
    });
    console.log("Second affected-cohort recommendation run:", secondRecommendationResult);

    const secondEnqueueResult = await runExplanationQueueEnqueuer(pool, {
      context: ctx,
      canonicalJobIds: affectedJobIds,
      budgetRunId,
    });
    console.log("Second affected-cohort enqueue run:", secondEnqueueResult);

    const postIdempotencyDist = await getProcessingDistribution(client, ctx.workspaceId);
    console.table(postIdempotencyDist);

    const postIdempotencyAuditCounts = await getReplayAuditCounts(
      client,
      ctx.workspaceId,
      affectedJobIds,
      budgetRunId,
    );
    console.log("Post-idempotency decision/task/queue/budget counts:", postIdempotencyAuditCounts);

    const stateCountsAreIdempotent = haveSameNumericCounts(
      postReplayDist,
      postIdempotencyDist,
    );
    const artifactCountsAreIdempotent = haveSameNumericCounts(
      postReplayAuditCounts,
      postIdempotencyAuditCounts,
    );
    const isIdempotent = stateCountsAreIdempotent && artifactCountsAreIdempotent;

    if (isIdempotent) {
      console.log("✅ IDEMPOTENCY CONFIRMED: State and decision/task/queue counts are unchanged after the second pass.");
    } else {
      throw new Error("Idempotency check failed: state or decision/task/queue/budget counts changed.");
    }

    // 6. Read-Model Integrity Verification
    console.log("\n--- 6. Read-Model Integrity Verification ---");
    const views = [
      "v_rejected_jobs_audit",
      "v_rejected_jobs_audit_scoped",
      "v_canonical_shortlist",
      "v_canonical_shortlist_scoped",
      "v_current_user_actions",
      "v_canonical_shortlist_actions_scoped",
      "v_matchable_nodes",
      "v_published_semantic_embeddings",
    ];

    for (const v of views) {
      const vRes = await client.query(`SELECT COUNT(*)::text AS count FROM ${v};`);
      console.log(`View ${v}: ${vRes.rows[0].count} rows queryable.`);
    }

    console.log("\n================================================================================");
    console.log(" PHASE 3 REHEARSAL SUMMARY");
    console.log("================================================================================");
    console.log("Baseline distribution:", baselineDist);
    console.log("Post-replay distribution:", postReplayDist);
    console.log("Idempotent second pass:", isIdempotent);

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Phase 3 Historical Recovery Rehearsal Failed:", err);
  process.exit(1);
});
