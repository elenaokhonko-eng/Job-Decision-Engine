import crypto from "node:crypto";
import { expect, vi } from "vitest";
import pg from "pg";

import { runMigrations } from "../../db/migrate.js";
import { pgConnectionConfig } from "../../db/pgSsl.js";
import { runEmbeddingBatchWithFallback } from "../../embeddings/batchCoordinator.js";
import { upsertLaneRevision } from "../../lanes/registry.js";
import { loadWorkspaceLanesConfig } from "../../pipeline/laneConfigLoader.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";
import { batchEmbeddingFromPerInput } from "./embeddingBatchMock.js";
import { insertCompletePostingEvidence } from "./completePostingEvidence.js";

/**
 * A real-PostgreSQL pipeline stack for tests that run the task worker end to end: migrated schema, an
 * ACTIVE profile with one fact, one synthetic lane, and routable synthetic jobs. Only the embedding
 * provider is replaced by a deterministic vector function. Synthetic data only.
 */
export interface StackJob {
  canonicalJobId: string;
  jobVersionId: string;
  requirementSetId: string;
  contentHash: string;
}

export interface PipelineStack {
  readonly db: pg.PoolClient;
  readonly ctx: WorkspaceContext;
  readonly schemaName: string;
  readonly profileVersionId: string;
  seedRoutableJob(key: string, facts?: { workplaceType: string; location: string }): Promise<StackJob>;
  publishEmbeddings(): Promise<void>;
  close(): Promise<void>;
}

const ENV_KEYS = [
  "REQUIREMENTS_ENABLE_QUOTED",
  "EMBEDDING_PRIMARY_PROVIDER",
  "EMBEDDING_PRIMARY_DIMENSIONS",
  "EMBEDDING_FALLBACK_DIMENSIONS",
] as const;

// Zebra text points one way, everything else another.
async function syntheticEmbedding(text: string): Promise<number[]> {
  return text.toLowerCase().includes("zebra") ? [1, 0, 0, 0] : [0, 1, 0, 0];
}

export async function openPipelineStack(databaseUrl: string, label: string): Promise<PipelineStack> {
  const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.REQUIREMENTS_ENABLE_QUOTED = "false";
  process.env.EMBEDDING_PRIMARY_PROVIDER = "gemini";
  process.env.EMBEDDING_PRIMARY_DIMENSIONS = "4";
  process.env.EMBEDDING_FALLBACK_DIMENSIONS = "4";
  const agent = await import("../../services/agent.js");
  vi.spyOn(agent, "generateEmbedding").mockImplementation(syntheticEmbedding);
  vi.spyOn(agent, "generateEmbeddingWithProvider").mockImplementation(syntheticEmbedding as any);
  vi.spyOn(agent, "generateEmbeddingWithProviderAndModel").mockImplementation(syntheticEmbedding as any);
  vi.spyOn(agent, "generateEmbeddingsWithProviderAndModel").mockImplementation(batchEmbeddingFromPerInput(syntheticEmbedding));

  const pool = new pg.Pool(pgConnectionConfig(databaseUrl));
  const client = await pool.connect();
  const schemaName = `${label}_${Date.now()}_${crypto.randomInt(100000, 999999)}`;
  await client.query(`CREATE SCHEMA ${schemaName}`);
  await client.query(`SET search_path TO ${schemaName}, public`);
  await runMigrations(client);
  const ctx = await resolveWorkspaceContext(client);
  const laneKey = `ZEBRA_${label.toUpperCase()}_LANE`;

  await loadWorkspaceLanesConfig(client, { context: ctx, seedIfEmpty: true });
  await upsertLaneRevision(
    {
      laneKey,
      content: {
        schema_version: "2.2.0",
        lane_key: laneKey,
        display_name: "Zebra stack test lane",
        description: "Synthetic lane for zebra telemetry platform engineering fixtures.",
        scope: {
          included_domain_concepts: { any: ["zebra telemetry"] },
          required_function_concepts: { any: ["platform engineer"] },
        },
        prototypes: [{ prototype_key: "zebra-platform", text: "Zebra telemetry platform engineer." }],
        routing: { minimum_semantic_score: 0.35 },
        budget: { maximum_ai_interpretations_per_run: 1 },
      },
    },
    client,
    { context: ctx, note: "pipeline stack fixture" },
  );
  const profile = await client.query<{ id: string }>(
    `INSERT INTO candidate_profiles (workspace_id, profile_key, display_name) VALUES ($1, $2, 'Zebra Stack Profile') RETURNING id`,
    [ctx.workspaceId, `zebra_stack_${label}`],
  );
  const version = await client.query<{ id: string }>(
    `INSERT INTO profile_versions (workspace_id, candidate_profile_id, version_number, schema_version, source_hash, status, effective_at)
     VALUES ($1, $2, 1, '2.2.0', $3, 'ACTIVE', NOW()) RETURNING id`,
    [ctx.workspaceId, profile.rows[0]!.id, `zebra-stack-profile-${label}`],
  );
  const profileVersionId = version.rows[0]!.id;
  await client.query(
    `INSERT INTO profile_facts (workspace_id, profile_version_id, fact_key, fact_type, statement, structured_value, evidence_tier, verification_status)
     VALUES ($1, $2, 'zebra-platform', 'SKILL', 'Zebra telemetry platform engineering for production streaming systems',
             '{}'::jsonb, 'PROFESSIONAL_PRODUCTION', 'VERIFIED')`,
    [ctx.workspaceId, profileVersionId],
  );

  async function seedRoutableJob(
    key: string,
    facts: { workplaceType: string; location: string } = { workplaceType: "REMOTE", location: "Remote" },
  ): Promise<StackJob> {
    const workspaceId = ctx.workspaceId;
    const description = [
      `About the role: zebra telemetry platform engineer (${key}) at a synthetic fixture employer.`,
      "Responsibilities: build and operate zebra telemetry ingestion services, review designs and support releases.",
      "Requirements: production platform engineering experience with streaming telemetry systems.",
    ].join(" ");
    const canonical = await client.query<{ id: string }>(
      `INSERT INTO canonical_jobs (
         workspace_id, company_name, normalized_title, canonical_url,
         location_summary, location, workplace_type, employment_type,
         processing_status, processing_state, gate_decision
       ) VALUES ($1, $2, $3, $4, $5, $5, $6, 'PERMANENT', 'PREQUALIFIED', 'PREQUALIFIED', 'PASS')
       RETURNING id`,
      [workspaceId, `Synthetic Zebra Stack Fixture ${key}`, `Zebra Telemetry Platform Engineer ${key}`,
       `https://example.test/zebra-stack-${label}-${key}`, facts.location, facts.workplaceType],
    );
    const canonicalJobId = canonical.rows[0]!.id;
    const contentHash = `zebra-stack-content-${label}-${key}`;
    const jv = await client.query<{ id: string }>(
      `INSERT INTO job_versions (workspace_id, canonical_job_id, version_number, content_hash, description_text)
       VALUES ($1, $2, 1, $3, $4) RETURNING id`,
      [workspaceId, canonicalJobId, contentHash, description],
    );
    const jobVersionId = jv.rows[0]!.id;
    await client.query(`UPDATE canonical_jobs SET latest_job_version_id = $1 WHERE workspace_id = $2 AND id = $3`, [jobVersionId, workspaceId, canonicalJobId]);
    await insertCompletePostingEvidence(client, {
      workspaceId, jobVersionId,
      companyName: `Synthetic Zebra Stack Fixture ${key}`,
      title: `Zebra Telemetry Platform Engineer ${key}`,
      sourceUrl: `https://example.test/zebra-stack-${label}-${key}`,
      description,
    });
    const identity = await client.query<{ id: string }>(
      `INSERT INTO requirement_set_identities (
         workspace_id, canonical_job_id, identity_hash, job_content_hash,
         deterministic_extractor_version, quoted_extractor_version, quoted_prompt_hash, normalizer_hash, quoted_enabled
       ) VALUES ($1, $2, $3, $4, 'deterministic-fixture-v1', 'quoted-fixture-v1', 'quoted-prompt-fixture-v1', 'normalizer-fixture-v1', FALSE)
       RETURNING id`,
      [workspaceId, canonicalJobId, `zebra-stack-identity-${label}-${key}`, contentHash],
    );
    const requirementSet = await client.query<{ id: string }>(
      `INSERT INTO requirement_sets (workspace_id, requirement_identity_id, canonical_job_id, job_version_id, revision_number, source_type)
       VALUES ($1, $2, $3, $4, 1, 'EXTRACTED') RETURNING id`,
      [workspaceId, identity.rows[0]!.id, canonicalJobId, jobVersionId],
    );
    const requirementSetId = requirementSet.rows[0]!.id;
    await client.query(`UPDATE job_versions SET active_requirement_set_id = $1 WHERE workspace_id = $2 AND id = $3`, [requirementSetId, workspaceId, jobVersionId]);
    await client.query(
      `INSERT INTO job_requirements (
         workspace_id, canonical_job_id, job_version_id, requirement_set_id, requirement_key, requirement_type, importance,
         requirement_text, extractor_type, extractor_version, confidence, status
       ) VALUES ($1, $2, $3, $4, 'function-1', 'FUNCTION', 'MUST', 'Zebra telemetry platform engineering experience',
                 'DETERMINISTIC', 'deterministic-fixture-v1', 1, 'VALIDATED')`,
      [workspaceId, canonicalJobId, jobVersionId, requirementSetId],
    );
    await client.query(
      `INSERT INTO requirement_extraction_runs (workspace_id, canonical_job_id, job_version_id, requirement_set_id, run_type, status, requirements_extracted, completed_at)
       VALUES ($1, $2, $3, $4, 'DETERMINISTIC', 'COMPLETED', 1, NOW())`,
      [workspaceId, canonicalJobId, jobVersionId, requirementSetId],
    );
    await client.query(
      `INSERT INTO job_version_pipeline_state (workspace_id, canonical_job_id, job_version_id, current_stage, stage_status)
       VALUES ($1, $2, $3, 'REQUIREMENTS_EXTRACTED', 'COMPLETED')`,
      [workspaceId, canonicalJobId, jobVersionId],
    );
    return { canonicalJobId, jobVersionId, requirementSetId, contentHash };
  }

  return {
    db: client,
    ctx,
    schemaName,
    profileVersionId,
    seedRoutableJob,
    async publishEmbeddings() {
      const summary = await runEmbeddingBatchWithFallback(500, client, { context: ctx });
      expect(summary.primary.failed).toBe(0);
    },
    async close() {
      vi.restoreAllMocks();
      for (const key of ENV_KEYS) {
        if (originalEnv[key] === undefined) delete process.env[key];
        else process.env[key] = originalEnv[key];
      }
      await client.query("RESET search_path").catch(() => undefined);
      await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
      await pool.end();
    },
  };
}
