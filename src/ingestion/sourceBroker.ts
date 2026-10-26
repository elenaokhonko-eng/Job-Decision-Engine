import { db } from "../db/db.js";
import { RawJobObservation } from "./types.js";
import pg from "pg";
import crypto from "crypto";
import dotenv from "dotenv";
import { pgPoolConfig } from "../db/pgSsl.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../workspace/context.js";
import { getActiveSourcePluginRevision, upsertSourcePluginRevision } from "./sourcePluginRegistry.js";
import type { SourcePlugin } from "../contracts/sourcePlugin.js";
import { ObservationPersistenceSchema, SCHEMA_VERSION } from "../contracts/index.js";
import { JobSourceEvidenceSchema, type JobSourceEvidence } from "../contracts/jobSourceEvidence.js";
import { buildJobSourceEvidence } from "./jobSourceEvidence.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

const defaultPool = new pg.Pool(pgPoolConfig(process.env.DATABASE_URL));

export interface StagedObservationResult {
  readonly observationId: string | null;
  readonly inserted: boolean;
  readonly normalizedEvidence?: JobSourceEvidence | null;
}

export interface SourceCandidateDispositionInput {
  readonly sourcePluginKey: string;
  readonly planKey: string;
  readonly laneKey: string | null;
  readonly sourceExternalId: string | null;
  readonly sourceUrl: string | null;
  readonly rawPayloadHash: string;
  readonly rawPayload: unknown;
  readonly normalizedEvidence?: JobSourceEvidence | null;
  readonly disposition: "STAGED" | "FILTERED" | "DUPLICATE" | "QUARANTINED" | "ERROR";
  readonly reasonCode?: string | null;
  readonly reasonDetail?: string | null;
  readonly canonicalJobId?: string | null;
  readonly observationId?: string | null;
}

export class SourceBroker {
  private sourceRunId: string | null = null;
  private stats = { fetched: 0, new: 0, duplicates: 0, errors: 0 };
  private errors: string[] = [];
  private executor: pg.Pool | pg.PoolClient;
  private context: WorkspaceContext | null = null;
  private sourcePluginRevisionCache = new Map<string, string | null>();
  private sourcePluginIdCache = new Map<string, string>();
  private sourcePluginColumnsAvailable: boolean | null = null;
  private sourceEvidenceColumnsAvailable: boolean | null = null;

  constructor(clientOrPool?: pg.Pool | pg.PoolClient, context?: WorkspaceContext) {
    this.executor = clientOrPool || defaultPool;
    this.context = context ?? null;
  }

  private async ensureContext(): Promise<WorkspaceContext> {
    if (this.context) {
      return this.context;
    }
    this.context = await resolveWorkspaceContext(this.executor as any);
    return this.context;
  }

  private async resolveSourcePluginRevisionId(
    sourcePluginKey: string,
    executor: pg.Pool | pg.PoolClient,
    ctx: WorkspaceContext
  ): Promise<string | null> {
    if (this.sourcePluginRevisionCache.has(sourcePluginKey)) {
      return this.sourcePluginRevisionCache.get(sourcePluginKey) ?? null;
    }

    try {
      const active = await getActiveSourcePluginRevision(sourcePluginKey, executor as any, { context: ctx });
      const revisionId = active?.sourcePluginRevisionId ?? null;
      this.sourcePluginRevisionCache.set(sourcePluginKey, revisionId);
      return revisionId;
    } catch (err: any) {
      // Allow running against pre-P12 databases (tables missing).
      if (err?.code === "42P01") {
        this.sourcePluginRevisionCache.set(sourcePluginKey, null);
        return null;
      }
      throw err;
    }
  }

  private async resolveSourcePluginId(sourcePluginKey: string, ctx: WorkspaceContext): Promise<string> {
    const cached = this.sourcePluginIdCache.get(sourcePluginKey);
    if (cached) return cached;
    const result = await this.executor.query<{ id: string }>(
      `SELECT id FROM source_plugins WHERE workspace_id = $1 AND source_key = $2 LIMIT 1`,
      [ctx.workspaceId, sourcePluginKey],
    );
    const pluginId = result.rows[0]?.id;
    if (!pluginId) throw new Error(`Source plugin ${sourcePluginKey} is not registered for this workspace.`);
    this.sourcePluginIdCache.set(sourcePluginKey, pluginId);
    return pluginId;
  }

  async loadSourceCheckpoint(sourcePluginKey: string, checkpointKey: string): Promise<Record<string, unknown> | null> {
    const ctx = await this.ensureContext();
    const sourcePluginId = await this.resolveSourcePluginId(sourcePluginKey, ctx);
    const result = await this.executor.query<{ checkpoint: unknown }>(
      `SELECT checkpoint FROM source_checkpoints
       WHERE workspace_id = $1 AND source_plugin_id = $2
         AND connector_account_id IS NULL AND checkpoint_key = $3
       LIMIT 1`,
      [ctx.workspaceId, sourcePluginId, checkpointKey],
    );
    const checkpoint = result.rows[0]?.checkpoint;
    if (checkpoint === null || checkpoint === undefined) return null;
    if (typeof checkpoint === "string") {
      try {
        const parsed: unknown = JSON.parse(checkpoint);
        return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
          ? Object.fromEntries(Object.entries(parsed))
          : null;
      } catch {
        throw new Error(`Checkpoint ${checkpointKey} for ${sourcePluginKey} contains invalid JSON.`);
      }
    }
    return typeof checkpoint === "object" && !Array.isArray(checkpoint)
      ? Object.fromEntries(Object.entries(checkpoint))
      : null;
  }

  async saveSourceCheckpoint(sourcePluginKey: string, checkpointKey: string, checkpoint: Record<string, unknown>): Promise<void> {
    const ctx = await this.ensureContext();
    const sourcePluginId = await this.resolveSourcePluginId(sourcePluginKey, ctx);
    await this.executor.query(
      `INSERT INTO source_checkpoints (workspace_id, source_plugin_id, checkpoint_key, checkpoint)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (source_plugin_id, checkpoint_key) WHERE connector_account_id IS NULL
       DO UPDATE SET checkpoint = EXCLUDED.checkpoint, updated_at = NOW()`,
      [ctx.workspaceId, sourcePluginId, checkpointKey, JSON.stringify(checkpoint)],
    );
  }

  async startSourcePlanRun(sourcePluginKey: string, planKey: string, planVersion: string, laneKey: string | null): Promise<string> {
    if (!this.sourceRunId) throw new Error("Must start a source run before starting a source plan.");
    const ctx = await this.ensureContext();
    const sourcePluginId = await this.resolveSourcePluginId(sourcePluginKey, ctx);
    const result = await this.executor.query<{ id: string }>(
      `INSERT INTO source_plan_runs (workspace_id, source_run_id, source_plugin_id, plan_key, plan_version, lane_key)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (source_run_id, source_plugin_id, plan_key, plan_version)
       DO UPDATE SET status = 'RUNNING', completed_at = NULL
       RETURNING id`,
      [ctx.workspaceId, this.sourceRunId, sourcePluginId, planKey, planVersion, laneKey],
    );
    const id = result.rows[0]?.id;
    if (!id) throw new Error(`Failed to start source plan ${planKey}.`);
    return id;
  }

  async finishSourcePlanRun(
    planRunId: string,
    status: "COMPLETED" | "DEGRADED" | "FAILED",
    counts: { pagesProcessed: number; itemsSeen: number; itemsStaged: number; itemsFiltered: number },
    errorSummary: readonly string[] = [],
    coverageNote?: string,
  ): Promise<void> {
    const ctx = await this.ensureContext();
    await this.executor.query(
      `UPDATE source_plan_runs
       SET status = $3, pages_processed = $4, items_seen = $5,
           items_staged = $6, items_filtered = $7, error_summary = $8::jsonb,
           coverage_note = $9, completed_at = NOW()
       WHERE workspace_id = $1 AND id = $2`,
      [ctx.workspaceId, planRunId, status, counts.pagesProcessed, counts.itemsSeen, counts.itemsStaged, counts.itemsFiltered, JSON.stringify(errorSummary), coverageNote ?? null],
    );
  }

  async recordCandidateDisposition(input: SourceCandidateDispositionInput, planRunId: string | null): Promise<void> {
    if (!this.sourceRunId) throw new Error("Must start a source run before recording a candidate disposition.");
    const ctx = await this.ensureContext();
    const normalizedEvidence = input.normalizedEvidence
      ? JobSourceEvidenceSchema.parse(input.normalizedEvidence)
      : null;
    await this.executor.query(
      `INSERT INTO source_candidate_dispositions (
         workspace_id, source_run_id, source_plan_run_id, source_plugin_key, plan_key,
         lane_key, source_external_id, source_url, raw_payload_hash, raw_payload,
         disposition, reason_code, reason_detail, canonical_job_id, job_observation_id,
         normalized_evidence, evidence_schema_version
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, $15, $16::jsonb, $17)`,
      [
        ctx.workspaceId, this.sourceRunId, planRunId, input.sourcePluginKey, input.planKey,
        input.laneKey, input.sourceExternalId, input.sourceUrl, input.rawPayloadHash,
        JSON.stringify(input.rawPayload ?? null), input.disposition, input.reasonCode ?? null,
        input.reasonDetail ?? null, input.canonicalJobId ?? null, input.observationId ?? null,
        normalizedEvidence ? JSON.stringify(normalizedEvidence) : null, normalizedEvidence?.schema_version ?? null,
      ],
    );
  }

  async ensureSourcePluginRevision(plugin: SourcePlugin): Promise<string> {
    const ctx = await this.ensureContext();
    const revision = await upsertSourcePluginRevision(plugin, this.executor, { context: ctx, activate: plugin.status === "active" });
    this.sourcePluginIdCache.delete(plugin.source_key);
    this.sourcePluginRevisionCache.delete(plugin.source_key);
    return revision.sourcePluginRevisionId;
  }

  async startRun(status: string = "RUNNING"): Promise<string> {
    const ctx = await this.ensureContext();
    const result = await this.executor.query(
      `INSERT INTO source_runs (workspace_id, status) VALUES ($1, $2) RETURNING id`,
      [ctx.workspaceId, status]
    );
    this.sourceRunId = result.rows[0].id;
    this.stats = { fetched: 0, new: 0, duplicates: 0, errors: 0 };
    this.errors = [];
    return this.sourceRunId as string;
  }

  recordError(message: string): void {
    this.stats.errors++;
    this.errors.push(message);
  }

  async processObservation(
    obs: Omit<RawJobObservation, "sourceRunId" | "rawPayloadHash">,
    rawPayload: unknown,
    executorOverride?: pg.Pool | pg.PoolClient,
  ): Promise<StagedObservationResult> {
    if (!this.sourceRunId) {
      throw new Error("Must start a source run before processing observations.");
    }

    const ctx = await this.ensureContext();
    
    this.stats.fetched++;
    
    const payloadStr = typeof rawPayload === "string" ? rawPayload : JSON.stringify(rawPayload);
    const rawPayloadHash = crypto.createHash("sha256").update(payloadStr).digest("hex");

    try {
      const executor = executorOverride || this.executor;
      const sourcePluginKey = (obs as any).sourcePluginKey
        ? String((obs as any).sourcePluginKey).trim()
        : String(obs.sourceName).toLowerCase();

      const sourcePluginRevisionId =
        typeof (obs as any).sourcePluginRevisionId === "string"
          ? String((obs as any).sourcePluginRevisionId).trim() || null
          : await this.resolveSourcePluginRevisionId(sourcePluginKey, executor, ctx);

      const persistenceInput = ObservationPersistenceSchema.parse({
        schema_version: SCHEMA_VERSION,
        workspace_id: ctx.workspaceId,
        source_run_id: this.sourceRunId,
        source_type: obs.sourceName,
        source_plugin_key: sourcePluginKey,
        source_plugin_revision_id: sourcePluginRevisionId,
        source_external_id: obs.sourceExternalId,
        source_url: obs.sourceUrl,
        retrieved_at: obs.retrievedAt || new Date().toISOString(),
        company_name_raw: obs.companyName,
        title_raw: obs.title,
        description_text: obs.descriptionRaw,
        location_raw: obs.locationRaw || null,
        workplace_type_raw: obs.workplaceTypeRaw || null,
        employment_type_raw: obs.employmentTypeRaw || null,
        compensation_raw: obs.compensationRaw || null,
        canonical_apply_url: obs.canonicalApplyUrl || null,
        source_lane: obs.sourceLane || null,
        search_plan_version: obs.searchPlanVersion,
        raw_payload: rawPayload,
        raw_payload_hash: rawPayloadHash,
      });
      let normalizedEvidence: JobSourceEvidence | null = null;
      let normalizedEvidenceError: string | null = null;
      try {
        normalizedEvidence = buildJobSourceEvidence({
          sourceName: persistenceInput.source_type,
          sourcePluginKey: persistenceInput.source_plugin_key,
          sourcePluginRevisionId: persistenceInput.source_plugin_revision_id,
          sourceExternalId: persistenceInput.source_external_id,
          sourceUrl: persistenceInput.source_url,
          canonicalApplyUrl: persistenceInput.canonical_apply_url,
          retrievedAt: persistenceInput.retrieved_at,
          rawPayloadHash: persistenceInput.raw_payload_hash,
          rawPayload: persistenceInput.raw_payload,
          companyName: persistenceInput.company_name_raw,
          title: persistenceInput.title_raw,
          locationRaw: persistenceInput.location_raw,
          workplaceTypeRaw: persistenceInput.workplace_type_raw,
          employmentTypeRaw: persistenceInput.employment_type_raw,
          compensationRaw: persistenceInput.compensation_raw,
          descriptionText: persistenceInput.description_text,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        normalizedEvidenceError = detail;
        this.recordError(`Normalized source evidence failed for observation ${rawPayloadHash}: ${detail}`);
      }

      const canUseSourcePluginColumns =
        this.sourcePluginColumnsAvailable === true || this.sourcePluginColumnsAvailable === null;
      const canUseSourceEvidenceColumns =
        canUseSourcePluginColumns && this.sourceEvidenceColumnsAvailable !== false;

      const sqlWithEvidence = `INSERT INTO raw_job_observations (
          workspace_id,
          source_run_id, source_name, source_plugin_key, source_plugin_revision_id,
          source_external_id, source_url,
          retrieved_at, company_name, title, description_raw,
          location_raw, workplace_type_raw, employment_type_raw, compensation_raw,
          canonical_apply_url, source_lane, search_plan_version,
          raw_payload, raw_payload_hash, normalized_evidence, evidence_schema_version
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21::jsonb, $22)
        ON CONFLICT (workspace_id, raw_payload_hash)
        DO UPDATE SET
          source_plugin_key = COALESCE(raw_job_observations.source_plugin_key, EXCLUDED.source_plugin_key),
          source_plugin_revision_id = COALESCE(raw_job_observations.source_plugin_revision_id, EXCLUDED.source_plugin_revision_id),
          normalized_evidence = COALESCE(raw_job_observations.normalized_evidence, EXCLUDED.normalized_evidence),
          evidence_schema_version = COALESCE(raw_job_observations.evidence_schema_version, EXCLUDED.evidence_schema_version)
        RETURNING id, (xmax = 0) AS inserted`;

      const sqlWithPlugin = `INSERT INTO raw_job_observations (
          workspace_id,
          source_run_id, source_name, source_plugin_key, source_plugin_revision_id,
          source_external_id, source_url,
          retrieved_at, company_name, title, description_raw,
          location_raw, workplace_type_raw, employment_type_raw, compensation_raw,
          canonical_apply_url, source_lane, search_plan_version,
          raw_payload, raw_payload_hash
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
        ON CONFLICT (workspace_id, raw_payload_hash)
        DO UPDATE SET
          source_plugin_key = COALESCE(raw_job_observations.source_plugin_key, EXCLUDED.source_plugin_key),
          source_plugin_revision_id = COALESCE(raw_job_observations.source_plugin_revision_id, EXCLUDED.source_plugin_revision_id)
        RETURNING id, (xmax = 0) AS inserted`;

      const sqlLegacy = `INSERT INTO raw_job_observations (
          workspace_id,
          source_run_id, source_name, source_external_id, source_url,
          retrieved_at, company_name, title, description_raw,
          location_raw, workplace_type_raw, employment_type_raw, compensation_raw,
          canonical_apply_url, source_lane, search_plan_version,
          raw_payload, raw_payload_hash
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
        ON CONFLICT (workspace_id, raw_payload_hash) DO NOTHING
        RETURNING id`;

      const pluginParams = [
        persistenceInput.workspace_id,
        persistenceInput.source_run_id,
        persistenceInput.source_type,
        persistenceInput.source_plugin_key,
        persistenceInput.source_plugin_revision_id,
        persistenceInput.source_external_id,
        persistenceInput.source_url,
        persistenceInput.retrieved_at,
        persistenceInput.company_name_raw,
        persistenceInput.title_raw,
        persistenceInput.description_text,
        persistenceInput.location_raw,
        persistenceInput.workplace_type_raw,
        persistenceInput.employment_type_raw,
        persistenceInput.compensation_raw,
        persistenceInput.canonical_apply_url,
        persistenceInput.source_lane,
        persistenceInput.search_plan_version,
        JSON.stringify(persistenceInput.raw_payload),
        persistenceInput.raw_payload_hash,
      ];
      const legacyParams = [
        persistenceInput.workspace_id,
        persistenceInput.source_run_id,
        persistenceInput.source_type,
        persistenceInput.source_external_id,
        persistenceInput.source_url,
        persistenceInput.retrieved_at,
        persistenceInput.company_name_raw,
        persistenceInput.title_raw,
        persistenceInput.description_text,
        persistenceInput.location_raw,
        persistenceInput.workplace_type_raw,
        persistenceInput.employment_type_raw,
        persistenceInput.compensation_raw,
        persistenceInput.canonical_apply_url,
        persistenceInput.source_lane,
        persistenceInput.search_plan_version,
        JSON.stringify(persistenceInput.raw_payload),
        persistenceInput.raw_payload_hash,
      ];
      const evidenceParams = [
        ...pluginParams,
        normalizedEvidence ? JSON.stringify(normalizedEvidence) : null,
        normalizedEvidence?.schema_version ?? null,
      ];
      const useEvidenceInsert = canUseSourceEvidenceColumns;
      const result = await executor.query(
        useEvidenceInsert ? sqlWithEvidence : canUseSourcePluginColumns ? sqlWithPlugin : sqlLegacy,
        useEvidenceInsert ? evidenceParams : canUseSourcePluginColumns ? pluginParams : legacyParams,
      );
      if (useEvidenceInsert) this.sourceEvidenceColumnsAvailable = true;
      const returnedRow = result.rows?.[0];
      const inserted = typeof returnedRow?.inserted === "boolean"
        ? returnedRow.inserted
        : (result.rowCount ?? 0) > 0;
      const returnedId: unknown = returnedRow?.id;
      let observationId = typeof returnedId === "string" ? returnedId : null;
      if (!observationId && !inserted) {
        const existingObservation = await executor.query<{ id: string }>(
          `SELECT id FROM raw_job_observations WHERE workspace_id = $1 AND raw_payload_hash = $2 LIMIT 1`,
          [persistenceInput.workspace_id, persistenceInput.raw_payload_hash],
        );
        observationId = existingObservation.rows[0]?.id ?? null;
      }
      if (inserted) this.stats.new++;
      else this.stats.duplicates++;
      if (normalizedEvidenceError && observationId) {
        await executor.query(
          `UPDATE raw_job_observations
           SET error_history = COALESCE(error_history, '[]'::jsonb) || jsonb_build_array($1::jsonb)
           WHERE workspace_id = $2 AND id = $3`,
          [
            JSON.stringify({
              stage: "NORMALIZED_SOURCE_EVIDENCE",
              error: normalizedEvidenceError,
              raw_payload_hash: persistenceInput.raw_payload_hash,
              occurred_at: persistenceInput.retrieved_at,
            }),
            persistenceInput.workspace_id,
            observationId,
          ],
        );
      }
      return { observationId, inserted, normalizedEvidence };
    } catch (err: any) {
      if (
        err?.code === "42703" &&
        typeof err?.message === "string" &&
        (err.message.includes("normalized_evidence") || err.message.includes("evidence_schema_version")) &&
        this.sourceEvidenceColumnsAvailable !== false
      ) {
        this.sourceEvidenceColumnsAvailable = false;
        return this.processObservation(obs, rawPayload, executorOverride);
      }
      if (
        err?.code === "42703" &&
        typeof err?.message === "string" &&
        err.message.includes("source_plugin") &&
        this.sourcePluginColumnsAvailable !== false
      ) {
        // Pre-plugin databases retry with the legacy observation insert shape.
        this.sourcePluginColumnsAvailable = false;
        this.sourceEvidenceColumnsAvailable = false;
        return this.processObservation(obs, rawPayload, executorOverride);
      }
      this.recordError(`Failed to stage observation "${obs.title}" from ${obs.companyName}: ${err.message}`);
      // INVARIANT: never swallow observation staging failures.
      // Callers must handle this error and must not mark the source email/record as processed.
      throw new Error(`Failed to stage observation "${obs.title}" from ${obs.companyName}: ${err.message}`);
    }
  }

  async endRun(status: string = "COMPLETED"): Promise<void> {
    if (!this.sourceRunId) return;
    
    await this.executor.query(
      `UPDATE source_runs 
       SET completed_at = NOW(), status = $1, total_fetched = $2, total_new = $3, total_duplicates = $4, total_errors = $5
           , error_log = $6::jsonb
         WHERE id = $7`,
      [
        status,
        this.stats.fetched,
        this.stats.new,
        this.stats.duplicates,
        this.stats.errors,
        JSON.stringify(this.errors),
        this.sourceRunId
      ]
    );
    console.log(`Source Run ${this.sourceRunId} completed. Stats:`, this.stats);
    this.sourceRunId = null;
  }
}
