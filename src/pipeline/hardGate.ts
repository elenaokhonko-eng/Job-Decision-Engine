import pg from "pg";
import dotenv from "dotenv";
import { applyGlobalGates } from "../services/criteria.js";
import { pgSslConfig } from "../db/pgSsl.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

const defaultPool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: pgSslConfig(process.env.DATABASE_URL)
});

export async function runHardGates(clientOrPool?: pg.Pool | pg.PoolClient): Promise<{ passed: number; hardRejected: number; needsVerification: number }> {
  console.log("Starting Hard Gate engine on RAW_STAGED canonical jobs...");
  const pool = clientOrPool || defaultPool;

  const { rows: stagedJobs } = await pool.query(`
    SELECT c.*, jv.description_text, jv.id AS job_version_id
    FROM canonical_jobs c
    JOIN LATERAL (
      SELECT id, description_text
      FROM job_versions
      WHERE canonical_job_id = c.id
      ORDER BY observed_at DESC
      LIMIT 1
    ) jv ON TRUE
    WHERE c.processing_status = 'RAW_STAGED'
  `);

  console.log(`Found ${stagedJobs.length} canonical jobs to gate.`);

  let passedCount = 0;
  let rejectedCount = 0;
  let needsVerificationCount = 0;

  const client = 'connect' in pool ? await pool.connect() : pool;
  try {
    for (const job of stagedJobs) {
      await client.query("BEGIN");
      try {
        const rawJobAdapter = {
          id: job.id,
          title: job.normalized_title,
          company_name: job.company_name,
          source: "canonical",
          raw_description: job.description_text,
          careers_portal_url: job.canonical_url,
          location: job.location,
          workplace_type: job.workplace_type,
          employment_type: job.employment_type
        };

        const gateResult = applyGlobalGates(rawJobAdapter as any);

        let processingStatus: string;
        switch (gateResult.status) {
          case "HARD_REJECT":
            processingStatus = "HARD_REJECTED";
            rejectedCount++;
            break;
          case "NEEDS_VERIFICATION":
            processingStatus = "NEEDS_VERIFICATION";
            needsVerificationCount++;
            break;
          default:
            processingStatus = "PREQUALIFIED";
            passedCount++;
        }

        // Update canonical job with gate outcome + structured workability facts + evidence
        await client.query(
          `UPDATE canonical_jobs
           SET gate_decision      = $1,
               processing_status  = $2,
               rejection_reason   = $3,
               gate_evidence_quotes = $4,
               workability_facts  = $5,
               updated_at         = NOW()
           WHERE id = $6`,
          [
            gateResult.status,
            processingStatus,
            gateResult.rejection_codes.length > 0 ? gateResult.rejection_codes.join(", ") : null,
            JSON.stringify(gateResult.evidence_quotes),
            JSON.stringify(gateResult.workability_facts),
            job.id
          ]
        );

        // Write immutable gate_decisions audit row (invariant 6)
        await client.query(
          `INSERT INTO gate_decisions (
             canonical_job_id, job_version_id, gate_version,
             decision, rejection_codes, evidence_quotes, workability_facts
           ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            job.id,
            job.job_version_id,
            "2.0",
            gateResult.status,
            JSON.stringify(gateResult.rejection_codes),
            JSON.stringify(gateResult.evidence_quotes),
            JSON.stringify(gateResult.workability_facts)
          ]
        );

        await client.query("COMMIT");

        const codeStr = gateResult.rejection_codes.length ? ` [${gateResult.rejection_codes.join(", ")}]` : "";
        console.log(`-> ${job.company_name} - ${job.normalized_title} : ${gateResult.status}${codeStr}`);
      } catch (err) {
        await client.query("ROLLBACK");
        console.error(`❌ Failed to gate job ${job.id}:`, err);
      }
    }
  } finally {
    if ('release' in client && typeof client.release === 'function') {
      client.release();
    }
  }

  console.log(
    `Hard Gates complete. Passed: ${passedCount}, Hard Rejected: ${rejectedCount}, Needs Verification: ${needsVerificationCount}`
  );
  return { passed: passedCount, hardRejected: rejectedCount, needsVerification: needsVerificationCount };
}
