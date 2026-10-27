import pg from "pg";
import { pgPoolConfig } from "../src/db/pgSsl.js";
import {
  isCurrentReadyApplicationReadiness,
  loadCurrentApplicationReadiness,
} from "../src/services/currentApplicationReadiness.js";
import { resolveWorkspaceContext } from "../src/workspace/context.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requiredUuid(value: string | undefined, name: string): string {
  if (!value || !UUID_PATTERN.test(value)) throw new Error(`A valid ${name} UUID is required.`);
  return value;
}

async function main(): Promise<void> {
  const applicationRecordId = requiredUuid(process.argv[2], "application record");
  const canonicalJobId = requiredUuid(process.argv[3], "canonical job");
  const jobVersionId = requiredUuid(process.argv[4], "job version");
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required for application draft validation.");

  const pool = new pg.Pool(pgPoolConfig(databaseUrl));
  const client = await pool.connect();
  let transactionStarted = false;
  try {
    const context = await resolveWorkspaceContext(client);
    await client.query("BEGIN");
    transactionStarted = true;
    await client.query("SET TRANSACTION READ ONLY");

    const { rows } = await client.query<{
      id: string;
      status: string;
      canonical_job_id: string;
      job_version_id: string;
      latest_job_version_id: string | null;
      gate_status: string | null;
      recommendation_eligibility: string | null;
      recommendation_outcome: string | null;
    }>(
      `SELECT application.id::text AS id,
              application.status,
              canonical.id::text AS canonical_job_id,
              application.job_version_id::text AS job_version_id,
              canonical.latest_job_version_id::text AS latest_job_version_id,
              shortlist.gate_status,
              shortlist.recommendation_eligibility,
              shortlist.recommendation_outcome
       FROM application_records application
       JOIN canonical_jobs canonical
         ON canonical.workspace_id = application.workspace_id
        AND canonical.id = application.canonical_job_id
       LEFT JOIN v_canonical_shortlist_scoped shortlist
         ON shortlist.workspace_id = canonical.workspace_id
        AND shortlist.canonical_job_id = canonical.id
        AND shortlist.job_version_id = application.job_version_id
       WHERE application.workspace_id = $1
         AND application.user_id = $2
         AND application.id = $3::uuid
         AND application.canonical_job_id = $4::uuid
         AND application.job_version_id = $5::uuid
       LIMIT 1`,
      [context.workspaceId, context.userId, applicationRecordId, canonicalJobId, jobVersionId],
    );
    const application = rows[0];
    if (!application) throw new Error("The application record does not match the selected user, job, and version.");
    if (application.status !== "INTENT") {
      throw new Error(`Document workflow requires an INTENT draft; received ${application.status}.`);
    }
    if (application.latest_job_version_id !== jobVersionId) {
      throw new Error("The application record does not reference the current job version.");
    }
    if (application.gate_status !== "PASS" ||
        application.recommendation_eligibility !== "ELIGIBLE" ||
        !["PRIORITY", "REVIEW"].includes(application.recommendation_outcome ?? "")) {
      throw new Error("The current deterministic decision does not permit application documents.");
    }

    const readiness = await loadCurrentApplicationReadiness(
      client,
      context.workspaceId,
      canonicalJobId,
      jobVersionId,
    );
    if (!readiness || !isCurrentReadyApplicationReadiness(readiness)) {
      throw new Error(`The selected job lacks current READY application evidence: ${readiness?.readiness_reason_codes?.[0] ?? "READINESS_NOT_READY"}.`);
    }

    await client.query("COMMIT");
    transactionStarted = false;
    console.log(JSON.stringify({
      event: "APPLICATION_DOCUMENT_PREFLIGHT_PASSED",
      applicationRecordId,
      applicationStatus: application.status,
      canonicalJobId,
      jobVersionId,
      readinessStatus: readiness.readiness_status,
      readinessReasonCodes: readiness.readiness_reason_codes,
    }));
  } catch (error) {
    if (transactionStarted) await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error("Application draft preflight failed:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
