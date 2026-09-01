import { db } from "../db/db.js";
import { RawJobObservation } from "./types.js";
import pg from "pg";
import crypto from "crypto";
import dotenv from "dotenv";
import { pgSslConfig } from "../db/pgSsl.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

const defaultPool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: pgSslConfig(process.env.DATABASE_URL)
});

export class SourceBroker {
  private sourceRunId: string | null = null;
  private stats = { fetched: 0, new: 0, duplicates: 0, errors: 0 };
  private errors: string[] = [];
  private executor: pg.Pool | pg.PoolClient;

  constructor(clientOrPool?: pg.Pool | pg.PoolClient) {
    this.executor = clientOrPool || defaultPool;
  }

  async startRun(status: string = "RUNNING"): Promise<string> {
    const result = await this.executor.query(
      `INSERT INTO source_runs (status) VALUES ($1) RETURNING id`,
      [status]
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
    
    this.stats.fetched++;
    
    const payloadStr = typeof rawPayload === "string" ? rawPayload : JSON.stringify(rawPayload);
    const rawPayloadHash = crypto.createHash("sha256").update(payloadStr).digest("hex");

    try {
      const executor = executorOverride || this.executor;
      const result = await executor.query(
        `INSERT INTO raw_job_observations (
          source_run_id, source_name, source_external_id, source_url, 
          retrieved_at, company_name, title, description_raw, 
          location_raw, workplace_type_raw, employment_type_raw, compensation_raw,
          canonical_apply_url, source_lane, search_plan_version, 
          raw_payload, raw_payload_hash
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        ON CONFLICT (raw_payload_hash) DO NOTHING`,
        [
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
          rawPayloadHash
        ]
      );
      if (result.rowCount && result.rowCount > 0) {
        this.stats.new++;
      } else {
        this.stats.duplicates++;
      }
    } catch (err: any) {
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
