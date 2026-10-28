import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";

export const COMPLETE_TEST_POSTING_DESCRIPTION = [
  "About the role: This position designs, builds, and operates production data and AI systems for business use.",
  "Responsibilities: Plan reliable implementations, review system behavior, resolve delivery risks, document decisions, and work with partner teams to maintain quality and measurable outcomes.",
  "Qualifications and skills: Demonstrated professional experience with relevant engineering methods, data quality, testing, stakeholder communication, and production support is required.",
].join(" ");

export async function insertCompletePostingEvidence(
  client: pg.Pool | pg.PoolClient,
  input: {
    readonly workspaceId: string;
    readonly jobVersionId: string;
    readonly companyName: string;
    readonly title: string;
    readonly sourceUrl: string;
    readonly description: string;
  },
): Promise<string> {
  const observationId = randomUUID();
  const responseHash = createHash("sha256").update(input.description).digest("hex");
  const rawPayload = {
    source_content_status: "COMPLETE",
    source_provider: "EMPLOYER_WEBSITE",
    content_hash: responseHash,
    source_evidence: {
      requestedUrl: input.sourceUrl,
      resolvedUrl: input.sourceUrl,
      responseHash,
    },
  };
  const rawPayloadHash = createHash("sha256").update(JSON.stringify(rawPayload)).digest("hex");

  await client.query(
    `INSERT INTO raw_job_observations (
       id, workspace_id, source_name, source_external_id, source_url, retrieved_at,
       company_name, title, description_raw, raw_payload, raw_payload_hash,
       processing_status, job_version_id
     ) VALUES (
       $1, $2, 'EMPLOYER_WEBSITE', $3, $4, NOW(), $5, $6, $7,
       $8::jsonb, $9, 'PROCESSED', $10::uuid
     )`,
    [
      observationId,
      input.workspaceId,
      `fixture-${observationId}`,
      input.sourceUrl,
      input.companyName,
      input.title,
      input.description,
      JSON.stringify(rawPayload),
      rawPayloadHash,
      input.jobVersionId,
    ],
  );
  await client.query(
    `UPDATE canonical_jobs canonical
     SET description_quality_status = 'COMPLETE', description_quality_reason = NULL
     FROM job_versions version
     WHERE version.workspace_id = $1
       AND version.id = $2::uuid
       AND canonical.workspace_id = version.workspace_id
       AND canonical.id = version.canonical_job_id`,
    [input.workspaceId, input.jobVersionId],
  );
  return observationId;
}
