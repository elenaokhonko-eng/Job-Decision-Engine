import { db } from "../db/db.js";
import { RawJobObservation } from "./types.js";
import pg from "pg";
import crypto from "crypto";
import dotenv from "dotenv";
import { pgPoolConfig } from "../db/pgSsl.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../workspace/context.js";
import { getActiveSourcePluginRevision } from "./sourcePluginRegistry.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

const defaultPool = new pg.Pool(pgPoolConfig(process.env.DATABASE_URL));

export class SourceBroker {
  private sourceRunId: string | null = null;
  private stats = { fetched: 0, new: 0, duplicates: 0, errors: 0 };
  private errors: string[] = [];
  private executor: pg.Pool | pg.PoolClient;
  private context: WorkspaceContext | null = null;
  private sourcePluginRevisionCache = new Map<string, string | null>();
  private sourcePluginColumnsAvailable: boolean | null = null;

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
    rawPayload: any,
    executorOverride?: pg.Pool | pg.PoolClient
  ): Promise<void> {
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
          ? String((obs as any).sourcePluginRevisionId).trim()
          : await this.resolveSourcePluginRevisionId(sourcePluginKey, executor, ctx);

      const canUseSourcePluginColumns =
        this.sourcePluginColumnsAvailable === true || this.sourcePluginColumnsAvailable === null;

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
        RETURNING (xmax = 0) AS inserted`;

      const sqlLegacy = `INSERT INTO raw_job_observations (
          workspace_id,
          source_run_id, source_name, source_external_id, source_url,
          retrieved_at, company_name, title, description_raw,
          location_raw, workplace_type_raw, employment_type_raw, compensation_raw,
          canonical_apply_url, source_lane, search_plan_version,
          raw_payload, raw_payload_hash
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
        ON CONFLICT (workspace_id, raw_payload_hash) DO NOTHING`;

      const result = await executor.query(
        canUseSourcePluginColumns ? sqlWithPlugin : sqlLegacy,
        canUseSourcePluginColumns
          ? [
              ctx.workspaceId,
              this.sourceRunId,
              obs.sourceName,
              sourcePluginKey,
              sourcePluginRevisionId,
              obs.sourceExternalId,
              obs.sourceUrl,
              obs.retrievedAt || new Date().toISOString(),
              obs.companyName,
              obs.title,
              obs.descriptionRaw,
              obs.locationRaw || null,
              obs.workplaceTypeRaw || null,
              obs.employmentTypeRaw || null,
              obs.compensationRaw || null,
              obs.canonicalApplyUrl || null,
              obs.sourceLane,
              obs.searchPlanVersion,
              JSON.stringify(rawPayload),
              rawPayloadHash,
            ]
          : [
              ctx.workspaceId,
              this.sourceRunId,
              obs.sourceName,
              obs.sourceExternalId,
              obs.sourceUrl,
              obs.retrievedAt || new Date().toISOString(),
              obs.companyName,
              obs.title,
              obs.descriptionRaw,
              obs.locationRaw || null,
              obs.workplaceTypeRaw || null,
              obs.employmentTypeRaw || null,
              obs.compensationRaw || null,
              obs.canonicalApplyUrl || null,
              obs.sourceLane,
              obs.searchPlanVersion,
              JSON.stringify(rawPayload),
              rawPayloadHash,
            ]
      );
      if (
        canUseSourcePluginColumns &&
        result.rows &&
        result.rows.length > 0 &&
        typeof result.rows[0]?.inserted === "boolean"
      ) {
        if (result.rows[0].inserted) {
          this.stats.new++;
        } else {
          this.stats.duplicates++;
        }
      } else if (result.rowCount && result.rowCount > 0) {
        this.stats.new++;
      } else {
        this.stats.duplicates++;
      }
    } catch (err: any) {
      if (
        err?.code === "42703" &&
        typeof err?.message === "string" &&
        err.message.includes("source_plugin") &&
        this.sourcePluginColumnsAvailable !== false
      ) {
        // Pre-P12 databases: retry with legacy insert shape (no plugin columns).
        this.sourcePluginColumnsAvailable = false;
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
