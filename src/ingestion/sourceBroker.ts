import { db } from "../db/db.js";
import { RawJobObservation } from "./types.js";
import pg from "pg";
import crypto from "crypto";
import dotenv from "dotenv";

dotenv.config();
dotenv.config({ path: ".env.local" });

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && (process.env.DATABASE_URL.includes("localhost") || process.env.DATABASE_URL.includes("127.0.0.1")) ? false : { rejectUnauthorized: false }
});

export class SourceBroker {
  private sourceRunId: string | null = null;
  private stats = { fetched: 0, new: 0, duplicates: 0, errors: 0 };

  async startRun(status: string = "RUNNING"): Promise<string> {
    const result = await pool.query(
      `INSERT INTO source_runs (status) VALUES ($1) RETURNING id`,
      [status]
    );
    this.sourceRunId = result.rows[0].id;
    this.stats = { fetched: 0, new: 0, duplicates: 0, errors: 0 };
    return this.sourceRunId as string;
  }

  async processObservation(obs: Omit<RawJobObservation, "sourceRunId" | "rawPayloadHash">, rawPayload: any): Promise<void> {
    if (!this.sourceRunId) {
      throw new Error("Must start a source run before processing observations.");
    }
    
    this.stats.fetched++;
    
    const payloadStr = typeof rawPayload === "string" ? rawPayload : JSON.stringify(rawPayload);
    const rawPayloadHash = crypto.createHash("sha256").update(payloadStr).digest("hex");

    try {
      // Basic exact-duplicate check for this source external ID in this run context (or overall)
      // Actually, we should just insert to the raw_job_observations table. It's append-only staging.
      
      await pool.query(
        `INSERT INTO raw_job_observations (
          source_run_id, source_name, source_external_id, source_url, 
          retrieved_at, company_name, title, description_raw, 
          source_lane, search_plan_version, raw_payload_hash
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          this.sourceRunId,
          obs.sourceName,
          obs.sourceExternalId,
          obs.sourceUrl,
          obs.retrievedAt || new Date().toISOString(),
          obs.companyName,
          obs.title,
          obs.descriptionRaw,
          obs.sourceLane,
          obs.searchPlanVersion,
          rawPayloadHash
        ]
      );
      this.stats.new++;
    } catch (err: any) {
      this.stats.errors++;
      console.error(`Failed to stage observation ${obs.title} from ${obs.companyName}: ${err.message}`);
    }
  }

  async endRun(status: string = "COMPLETED"): Promise<void> {
    if (!this.sourceRunId) return;
    
    await pool.query(
      `UPDATE source_runs 
       SET completed_at = NOW(), status = $1, total_fetched = $2, total_new = $3, total_duplicates = $4, total_errors = $5
       WHERE id = $6`,
      [
        status,
        this.stats.fetched,
        this.stats.new,
        this.stats.duplicates,
        this.stats.errors,
        this.sourceRunId
      ]
    );
    console.log(`Source Run ${this.sourceRunId} completed. Stats:`, this.stats);
    this.sourceRunId = null;
  }
}
