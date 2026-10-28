import dotenv from "dotenv";
import pg from "pg";

import { pgPoolConfig } from "../src/db/pgSsl.js";
import { getActiveDocumentTemplatePluginRevision } from "../src/documents/plugins.js";
import { assertApplicationDocumentPairCurrent } from "../src/documents/documentPairPolicy.js";
import { parseDocumentOutputManifest, type DocumentOutputManifestRecord } from "../src/documents/outputManifest.js";
import { validatePersistedDocumentCurrentness } from "../src/documents/provenanceCurrentness.js";
import { resolveWorkspaceContext } from "../src/workspace/context.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

interface DocumentRunRow {
  readonly id: string;
  readonly canonical_job_id: string;
  readonly job_version_id: string;
  readonly match_run_id: string | null;
  readonly profile_version_id: string | null;
  readonly deterministic_decision_id: string | null;
  readonly context_fingerprint: string | null;
  readonly document_type: "CV" | "COVER_LETTER";
  readonly document_template_plugin_revision_id: string | null;
  readonly output_manifest: DocumentOutputManifestRecord;
}

interface PairRunResult {
  readonly ready: boolean;
  readonly reason: string | null;
  readonly run: DocumentRunRow | null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requiredUuid(value: string | undefined, label: string): string {
  if (!value || !UUID_PATTERN.test(value)) throw new Error(`Provide a valid ${label} UUID.`);
  return value;
}

async function readRun(
  client: pg.PoolClient,
  context: Awaited<ReturnType<typeof resolveWorkspaceContext>>,
  application: { canonical_job_id: string; job_version_id: string; cv_document_run_id: string | null; cover_letter_document_run_id: string | null },
  runId: string | null,
  documentType: "CV" | "COVER_LETTER",
): Promise<PairRunResult> {
  if (!runId) return { ready: false, reason: "DOCUMENT_RUN_MISSING", run: null };
  const { rows } = await client.query<Omit<DocumentRunRow, "output_manifest"> & { readonly output_manifest: unknown }>(
    `SELECT id, canonical_job_id, job_version_id, match_run_id, profile_version_id,
            deterministic_decision_id, context_fingerprint, document_type,
            document_template_plugin_revision_id, output_manifest
     FROM document_runs
     WHERE workspace_id = $1 AND id = $2::uuid AND canonical_job_id = $3::uuid
       AND job_version_id = $4::uuid AND document_type = $5 AND status = 'COMPLETED'
     LIMIT 1`,
    [context.workspaceId, runId, application.canonical_job_id, application.job_version_id, documentType],
  );
  const persistedRun = rows[0];
  if (!persistedRun || persistedRun.id !== runId) {
    return { ready: false, reason: "DOCUMENT_RUN_NOT_FOUND", run: null };
  }
  let run: DocumentRunRow;
  try {
    run = { ...persistedRun, output_manifest: parseDocumentOutputManifest(persistedRun.output_manifest) };
  } catch {
    return { ready: false, reason: "DOCUMENT_MANIFEST_INVALID", run: null };
  }

  const currentness = await validatePersistedDocumentCurrentness(client, context.workspaceId, {
    canonicalJobId: run.canonical_job_id,
    jobVersionId: run.job_version_id,
    matchRunId: run.match_run_id,
    profileVersionId: run.profile_version_id,
    deterministicDecisionId: run.deterministic_decision_id,
    contextFingerprint: run.context_fingerprint,
  });
  if (!currentness.current) return { ready: false, reason: currentness.reason, run };

  const activeTemplate = await getActiveDocumentTemplatePluginRevision(documentType, client, { context });
  if ((activeTemplate?.revisionId ?? null) !== run.document_template_plugin_revision_id) {
    return { ready: false, reason: "DOCUMENT_TEMPLATE_STALE", run };
  }

  return { ready: true, reason: null, run };
}

async function main(): Promise<void> {
  const requireCurrentPair = process.argv.includes("--require-current");
  const positionalArgs = process.argv.slice(2).filter((argument) => argument !== "--require-current");
  const applicationRecordId = requiredUuid(positionalArgs[0], "application record");
  const cvDocumentRunId = requiredUuid(positionalArgs[1], "CV document run");
  const coverLetterDocumentRunId = requiredUuid(positionalArgs[2], "cover-letter document run");
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required for read-only document pair verification.");

  const pool = new pg.Pool(pgPoolConfig(databaseUrl));
  const client = await pool.connect();
  let transactionStarted = false;
  try {
    const context = await resolveWorkspaceContext(client);
    await client.query("BEGIN");
    transactionStarted = true;
    await client.query("SET TRANSACTION READ ONLY");

    const { rows: applicationRows } = await client.query<{
      id: string;
      canonical_job_id: string;
      job_version_id: string;
      cv_document_run_id: string | null;
      cover_letter_document_run_id: string | null;
    }>(
      `SELECT id, canonical_job_id, job_version_id, cv_document_run_id, cover_letter_document_run_id
       FROM application_records
       WHERE workspace_id = $1 AND user_id = $2 AND id = $3::uuid
       LIMIT 1`,
      [context.workspaceId, context.userId, applicationRecordId],
    );
    const application = applicationRows[0];
    if (!application) throw new Error("Application record is not available to the current workspace user.");

    const [cv, coverLetter] = await Promise.all([
      readRun(client, context, application, cvDocumentRunId, "CV"),
      readRun(client, context, application, coverLetterDocumentRunId, "COVER_LETTER"),
    ]);
    const linkedToApplication = application.cv_document_run_id === cvDocumentRunId &&
      application.cover_letter_document_run_id === coverLetterDocumentRunId;
    const sameContext = Boolean(cv.run && coverLetter.run &&
      cv.run.canonical_job_id === coverLetter.run.canonical_job_id &&
      cv.run.job_version_id === coverLetter.run.job_version_id &&
      cv.run.profile_version_id === coverLetter.run.profile_version_id &&
      cv.run.deterministic_decision_id === coverLetter.run.deterministic_decision_id &&
      cv.run.context_fingerprint === coverLetter.run.context_fingerprint);
    const pairCurrent = Boolean(linkedToApplication && sameContext && cv.ready && coverLetter.ready);
    assertApplicationDocumentPairCurrent(pairCurrent, requireCurrentPair);

    let reviewedAt: string | null = null;
    if (pairCurrent && cv.run && coverLetter.run) {
      const cvHash = typeof cv.run.output_manifest.docx_sha256 === "string"
        ? cv.run.output_manifest.docx_sha256
        : null;
      const coverLetterHash = typeof coverLetter.run.output_manifest.docx_sha256 === "string"
        ? coverLetter.run.output_manifest.docx_sha256
        : null;
      if (cvHash && coverLetterHash) {
        const { rows: reviewRows } = await client.query<{ created_at: string }>(
          `SELECT created_at
           FROM application_events
           WHERE workspace_id = $1 AND application_record_id = $2::uuid
             AND event_payload->>'event' = 'DOCUMENT_PAIR_REVIEWED'
             AND event_payload->>'cv_document_run_id' = $3
             AND event_payload->>'cover_letter_document_run_id' = $4
             AND event_payload->>'cv_sha256' = $5
             AND event_payload->>'cover_letter_sha256' = $6
           ORDER BY created_at DESC
           LIMIT 1`,
          [context.workspaceId, applicationRecordId, cvDocumentRunId, coverLetterDocumentRunId, cvHash, coverLetterHash],
        );
        reviewedAt = reviewRows[0]?.created_at ?? null;
      }
    }

    await client.query("COMMIT");
    transactionStarted = false;
    console.log(JSON.stringify({
      event: "APPLICATION_DOCUMENT_PAIR_VALIDATED",
      mode: "READ_ONLY",
      applicationRecordId,
      cvDocumentRunId,
      coverLetterDocumentRunId,
      cvReady: cv.ready,
      cvReason: cv.reason,
      coverLetterReady: coverLetter.ready,
      coverLetterReason: coverLetter.reason,
      linkedToApplication,
      pairCurrent,
      reviewedAt,
      documentReady: pairCurrent && reviewedAt !== null,
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
  console.error("Application document-pair validation failed:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
