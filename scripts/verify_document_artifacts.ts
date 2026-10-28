import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import JSZip from "jszip";
import { PDFParse } from "pdf-parse";
import { pgPoolConfig } from "../src/db/pgSsl.js";
import { loadProfileContactInfo, requireCvContactInfo } from "../src/documents/contactInfo.js";
import { extractReadableDocumentXmlText } from "../src/documents/documentArtifactValidation.js";
import { parseDocumentOutputManifest } from "../src/documents/outputManifest.js";
import { validatePersistedDocumentCurrentness } from "../src/documents/provenanceCurrentness.js";
import { ContactFactRevisionSchema } from "../src/profile/contactFactContract.js";
import { isCurrentReadyApplicationReadiness, loadCurrentApplicationReadiness } from "../src/services/currentApplicationReadiness.js";
import { resolveWorkspaceContext } from "../src/workspace/context.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DOCX_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

interface DocumentRun extends pg.QueryResultRow {
  readonly id: string;
  readonly canonical_job_id: string;
  readonly job_version_id: string;
  readonly profile_version_id: string;
  readonly match_run_id: string | null;
  readonly deterministic_decision_id: string | null;
  readonly context_fingerprint: string | null;
  readonly document_type: "CV" | "COVER_LETTER";
  readonly output_manifest: unknown;
}

function requiredUuid(value: string | undefined, label: string): string {
  if (!value || !UUID_PATTERN.test(value)) throw new Error(`A valid ${label} UUID is required.`);
  return value;
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function digits(value: string): string {
  return value.replace(/\D/g, "");
}

export function containsPhoneNumber(documentText: string, phone: string): boolean {
  const phoneDigits = digits(phone);
  return phoneDigits.length > 0 && digits(documentText).includes(phoneDigits);
}

export async function readVerifiedArtifact(
  manifest: Record<string, unknown>,
  format: "docx" | "pdf",
  exportRoot: string,
): Promise<{ readonly path: string; readonly content: Buffer }> {
  const artifactPath = manifest[`${format}_path`];
  const expectedHash = manifest[`${format}_sha256`];
  if (typeof artifactPath !== "string" || typeof expectedHash !== "string" || !/^[a-f0-9]{64}$/.test(expectedHash)) {
    throw new Error(`The ${format.toUpperCase()} run manifest is missing a valid path or SHA-256 hash.`);
  }

  const resolvedRoot = await fs.realpath(exportRoot);
  const resolvedArtifact = path.resolve(resolvedRoot, path.basename(artifactPath));
  const actualPath = await fs.realpath(resolvedArtifact);
  if (!actualPath.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`The ${format.toUpperCase()} artifact resolves outside the exports directory.`);
  }
  const content = await fs.readFile(actualPath);
  if (sha256(content) !== expectedHash) {
    throw new Error(`The ${format.toUpperCase()} artifact hash does not match its persisted document run.`);
  }
  return { path: actualPath, content };
}

export async function extractDocxText(filePath: string, content: Buffer): Promise<string> {
  if (!content.subarray(0, DOCX_SIGNATURE.length).equals(DOCX_SIGNATURE)) {
    throw new Error(`DOCX artifact ${path.basename(filePath)} is not a ZIP-based Office document.`);
  }
  try {
    const archive = await JSZip.loadAsync(content);
    if (!archive.file("[Content_Types].xml")) {
      throw new Error("DOCX package content types are missing.");
    }
    const documentXml = archive.file("word/document.xml");
    if (!documentXml) throw new Error("DOCX package document.xml is missing.");
    return extractReadableDocumentXmlText(await documentXml.async("string"));
  } catch (error) {
    throw new Error(
      `DOCX artifact ${path.basename(filePath)} is invalid or unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function extractPdfText(content: Buffer, filePath: string): Promise<{ readonly text: string; readonly pages: number }> {
  const parser = new PDFParse({ data: content });
  try {
    const parsed = await parser.getText();
    if (!Number.isInteger(parsed.total) || parsed.total < 1 || !parsed.text.trim()) {
      throw new Error(`PDF artifact ${path.basename(filePath)} has no readable pages or text.`);
    }
    return { text: parsed.text, pages: parsed.total };
  } finally {
    await parser.destroy();
  }
}

async function main(): Promise<void> {
  const applicationRecordId = requiredUuid(process.argv[2], "application record");
  const canonicalJobId = requiredUuid(process.argv[3], "canonical job");
  const jobVersionId = requiredUuid(process.argv[4], "job version");
  const cvDocumentRunId = requiredUuid(process.argv[5], "CV document run");
  const coverLetterDocumentRunId = requiredUuid(process.argv[6], "cover-letter document run");
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required for document artifact verification.");

  const pool = new pg.Pool(pgPoolConfig(databaseUrl));
  const client = await pool.connect();
  let transactionStarted = false;
  try {
    await client.query("BEGIN");
    transactionStarted = true;
    await client.query("SET TRANSACTION READ ONLY");
    const context = await resolveWorkspaceContext(client);
    const { rows: applications } = await client.query<{
      readonly status: string;
      readonly cv_document_run_id: string | null;
      readonly cover_letter_document_run_id: string | null;
    }>(
      `SELECT application.status,
              application.cv_document_run_id::text,
              application.cover_letter_document_run_id::text
       FROM application_records application
       JOIN canonical_jobs canonical
         ON canonical.workspace_id = application.workspace_id
        AND canonical.id = application.canonical_job_id
       WHERE application.workspace_id = $1
         AND application.user_id = $2
         AND application.id = $3::UUID
         AND application.canonical_job_id = $4::UUID
         AND application.job_version_id = $5::UUID
       LIMIT 1`,
      [context.workspaceId, context.userId, applicationRecordId, canonicalJobId, jobVersionId],
    );
    const application = applications[0];
    if (!application || application.status !== "INTENT") {
      throw new Error("Document verification requires the matching INTENT draft application.");
    }
    if (application.cv_document_run_id !== cvDocumentRunId ||
        application.cover_letter_document_run_id !== coverLetterDocumentRunId) {
      throw new Error("The application draft is not linked to both requested document runs.");
    }
    const readiness = await loadCurrentApplicationReadiness(
      client,
      context.workspaceId,
      canonicalJobId,
      jobVersionId,
    );
    if (!isCurrentReadyApplicationReadiness(readiness)) {
      throw new Error("The selected job no longer has current READY application evidence.");
    }

    const { rows } = await client.query<DocumentRun>(
      `SELECT id::text, canonical_job_id::text, job_version_id::text,
              profile_version_id::text, match_run_id::text, deterministic_decision_id::text,
              context_fingerprint, document_type, output_manifest
       FROM document_runs
       WHERE workspace_id = $1
         AND id = ANY($2::UUID[])
         AND status = 'COMPLETED'`,
      [context.workspaceId, [cvDocumentRunId, coverLetterDocumentRunId]],
    );
    const cvRun = rows.find((run) => run.id === cvDocumentRunId && run.document_type === "CV");
    const coverLetterRun = rows.find((run) => run.id === coverLetterDocumentRunId && run.document_type === "COVER_LETTER");
    for (const run of [cvRun, coverLetterRun]) {
      if (!run || run.canonical_job_id !== canonicalJobId || run.job_version_id !== jobVersionId) {
        throw new Error("A document run is not linked to the selected application, job, and version.");
      }
    }
    if (cvRun!.profile_version_id !== coverLetterRun!.profile_version_id) {
      throw new Error("The CV and cover letter were generated from different profile versions.");
    }
    const cvManifest = parseDocumentOutputManifest(cvRun!.output_manifest);
    const coverLetterManifest = parseDocumentOutputManifest(coverLetterRun!.output_manifest);
    for (const run of [cvRun!, coverLetterRun!]) {
      const currentness = await validatePersistedDocumentCurrentness(client, context.workspaceId, {
        canonicalJobId,
        jobVersionId,
        matchRunId: run.match_run_id,
        profileVersionId: run.profile_version_id,
        deterministicDecisionId: run.deterministic_decision_id,
        contextFingerprint: run.context_fingerprint,
      });
      if (!currentness.current) {
        throw new Error(`Document run ${run.id} is stale: ${currentness.reason}.`);
      }
    }

    const profile = await client.query<{ candidate_name: string }>(
      `SELECT candidate.display_name AS candidate_name
       FROM profile_versions profile_version
       JOIN candidate_profiles candidate
         ON candidate.workspace_id = profile_version.workspace_id
        AND candidate.id = profile_version.candidate_profile_id
       WHERE profile_version.workspace_id = $1
         AND profile_version.id = $2::UUID
       LIMIT 1`,
      [context.workspaceId, cvRun!.profile_version_id],
    );
    const candidateName = profile.rows[0]?.candidate_name?.trim();
    if (!candidateName) throw new Error("The document profile version has no authoritative candidate name.");
    const graphPhoneResult = await client.query<{
      readonly fact_key: string;
      readonly fact_type: string;
      readonly structured_value: unknown;
      readonly verification_status: string;
      readonly confidentiality: string;
    }>(
      `SELECT fact_key, fact_type, structured_value, verification_status, confidentiality
       FROM profile_facts
       WHERE workspace_id = $1 AND profile_version_id = $2::UUID
         AND fact_key = 'contact_phone' AND fact_type = 'CONTACT'
         AND confidentiality = 'PRIVATE_INTERNAL'
         AND verification_status IN ('VERIFIED', 'SELF_ATTESTED')
         AND is_current = TRUE
       LIMIT 1`,
      [context.workspaceId, cvRun!.profile_version_id],
    );
    const graphPhoneFact = graphPhoneResult.rows[0];
    const parsedGraphPhone = ContactFactRevisionSchema.safeParse(graphPhoneFact);
    if (!parsedGraphPhone.success || parsedGraphPhone.data.structured_value.kind !== "phone") {
      throw new Error("The active profile graph has no valid private contact phone fact.");
    }
    const contact = requireCvContactInfo(await loadProfileContactInfo(
      client,
      context.workspaceId,
      cvRun!.profile_version_id,
      candidateName,
    ));
    const graphPhone = parsedGraphPhone.data.structured_value.value;
    if (contact.phone !== graphPhone) {
      throw new Error("The CV contact resolver did not use the active profile-graph phone.");
    }
    await client.query("COMMIT");
    transactionStarted = false;

    const exportRoot = path.resolve("scripts", "exports");
    const [cvDocx, cvPdf, letterDocx, letterPdf] = await Promise.all([
      readVerifiedArtifact(cvManifest, "docx", exportRoot),
      readVerifiedArtifact(cvManifest, "pdf", exportRoot),
      readVerifiedArtifact(coverLetterManifest, "docx", exportRoot),
      readVerifiedArtifact(coverLetterManifest, "pdf", exportRoot),
    ]);
    const [cvDocxText, cvPdfText, letterDocxText, letterPdfText] = await Promise.all([
      extractDocxText(cvDocx.path, cvDocx.content),
      extractPdfText(cvPdf.content, cvPdf.path),
      extractDocxText(letterDocx.path, letterDocx.content),
      extractPdfText(letterPdf.content, letterPdf.path),
    ]);
    if (!containsPhoneNumber(cvDocxText, graphPhone) || !containsPhoneNumber(cvPdfText.text, graphPhone)) {
      throw new Error("The required active-profile phone number was not found in both rendered CV formats.");
    }

    await client.query("BEGIN");
    transactionStarted = true;
    await client.query("SET TRANSACTION READ ONLY");
    const [latestApplication, latestReadiness] = await Promise.all([
      client.query<{ status: string; cv_document_run_id: string | null; cover_letter_document_run_id: string | null }>(
        `SELECT status, cv_document_run_id::text, cover_letter_document_run_id::text
         FROM application_records
         WHERE workspace_id = $1 AND user_id = $2 AND id = $3::UUID
           AND canonical_job_id = $4::UUID AND job_version_id = $5::UUID
         LIMIT 1`,
        [context.workspaceId, context.userId, applicationRecordId, canonicalJobId, jobVersionId],
      ),
      loadCurrentApplicationReadiness(client, context.workspaceId, canonicalJobId, jobVersionId),
    ]);
    const currentApplication = latestApplication.rows[0];
    if (currentApplication?.status !== "INTENT" ||
        currentApplication.cv_document_run_id !== cvDocumentRunId ||
        currentApplication.cover_letter_document_run_id !== coverLetterDocumentRunId ||
        !isCurrentReadyApplicationReadiness(latestReadiness)) {
      throw new Error("The application or readiness context changed while document artifacts were being inspected.");
    }
    const [currentCv, currentLetter] = await Promise.all([
      validatePersistedDocumentCurrentness(client, context.workspaceId, {
        canonicalJobId,
        jobVersionId,
        matchRunId: cvRun!.match_run_id,
        profileVersionId: cvRun!.profile_version_id,
        deterministicDecisionId: cvRun!.deterministic_decision_id,
        contextFingerprint: cvRun!.context_fingerprint,
      }),
      validatePersistedDocumentCurrentness(client, context.workspaceId, {
        canonicalJobId,
        jobVersionId,
        matchRunId: coverLetterRun!.match_run_id,
        profileVersionId: coverLetterRun!.profile_version_id,
        deterministicDecisionId: coverLetterRun!.deterministic_decision_id,
        contextFingerprint: coverLetterRun!.context_fingerprint,
      }),
    ]);
    if (!currentCv.current || !currentLetter.current) {
      throw new Error("The document pair became stale while artifact files were being inspected.");
    }
    await client.query("COMMIT");
    transactionStarted = false;

    console.log(JSON.stringify({
      event: "DOCUMENT_ARTIFACTS_VERIFIED",
      applicationRecordId,
      canonicalJobId,
      jobVersionId,
      cvDocumentRunId,
      coverLetterDocumentRunId,
      formats: {
        cv: { docx: path.basename(cvDocx.path), pdf: path.basename(cvPdf.path), pdfPages: cvPdfText.pages, phonePresentInDocx: true, phonePresentInPdf: true },
        coverLetter: { docx: path.basename(letterDocx.path), pdf: path.basename(letterPdf.path), pdfPages: letterPdfText.pages },
      },
    }));
  } catch (error) {
    if (transactionStarted) await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1]?.endsWith("verify_document_artifacts.ts")) {
  main().catch((error: unknown) => {
    console.error("Document artifact verification failed:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
