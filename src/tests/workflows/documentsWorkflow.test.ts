import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getDocumentWorkflowDispatchFailure } from "../../services/documentWorkflowDispatchPolicy.js";

describe("documents workflow", () => {
  const validDispatch = {
    repositoryPrivate: true,
    requestedRef: "refs/heads/main",
    canonicalJobId: "11111111-1111-4111-8111-111111111111",
    jobVersionId: "22222222-2222-4222-8222-222222222222",
    applicationRecordId: "33333333-3333-4333-8333-333333333333",
  };

  it("rejects document generation for public repositories", () => {
    expect(
      getDocumentWorkflowDispatchFailure({ ...validDispatch, repositoryPrivate: false }),
    ).toMatch(/disabled for public repositories/i);
  });

  it("rejects unreviewed refs and unpinned document identities", () => {
    expect(
      getDocumentWorkflowDispatchFailure({ ...validDispatch, requestedRef: "refs/heads/feature" }),
    ).toMatch(/reviewed code from main/i);
    expect(
      getDocumentWorkflowDispatchFailure({ ...validDispatch, jobVersionId: "not-a-uuid" }),
    ).toMatch(/valid UUIDs/i);
  });

  it("accepts only fully pinned dispatches on private main", () => {
    expect(getDocumentWorkflowDispatchFailure(validDispatch)).toBeNull();
  });

  it("requires pinned application and job identities before document generation", () => {
    const workflow = readFileSync(resolve(".github/workflows/documents.yml"), "utf8");
    const dispatchPolicy = readFileSync(resolve("scripts/validate_document_workflow_dispatch.ts"), "utf8");
    const preflight = readFileSync(resolve("scripts/preflight_application_document_draft.ts"), "utf8");
    const preflightService = readFileSync(resolve("src/documents/applicationDocumentPreflight.ts"), "utf8");
    const cvGenerator = readFileSync(resolve("scripts/generate_cv.ts"), "utf8");
    const coverLetterGenerator = readFileSync(resolve("scripts/generate_cover_letter.ts"), "utf8");
    const pairValidator = readFileSync(resolve("scripts/validate_application_document_pair.ts"), "utf8");
    const artifactVerifier = readFileSync(resolve("scripts/verify_document_artifacts.ts"), "utf8");

    expect(workflow).toContain("application_record_id:");
    expect(workflow).toContain("required: true");
    expect(workflow).toContain("refs/heads/main");
    expect(workflow).toContain("REPOSITORY_PRIVATE: ${{ github.event.repository.private }}");
    expect(workflow).toContain("validate_document_workflow_dispatch.ts");
    expect(workflow).toContain("github.event.repository.private == true");
    expect(dispatchPolicy).toContain("getDocumentWorkflowDispatchFailure");
    expect(workflow).toContain("APPLICATION_RECORD_ID=$INPUT_APPLICATION_RECORD_ID");
    expect(workflow).toContain("DOCUMENTS_JOB_FOUND=true");
    expect(preflightService).toContain('application.status !== "INTENT"');
    expect(preflightService).toContain("sourceContentEvidencePredicate");
    expect(preflightService).toContain("description_quality_status !== \"COMPLETE\"");
    expect(cvGenerator).toContain("sourceContentEvidencePredicate");
    expect(coverLetterGenerator).toContain("sourceContentEvidencePredicate");
    expect(workflow).toContain("if: env.DOCUMENTS_JOB_FOUND == 'true'");
    expect(workflow).toContain("success() && env.DOCUMENTS_JOB_FOUND == 'true'");
    expect(workflow).toContain("validate_application_document_pair.ts");
    expect(workflow).toContain("--require-current");
    expect(workflow).toContain("verify_document_artifacts.ts");
    expect(pairValidator).toContain("assertApplicationDocumentPairCurrent(pairCurrent, requireCurrentPair)");
    expect(artifactVerifier).toContain("phonePresentInDocx: true");
    expect(artifactVerifier).toContain("phonePresentInPdf: true");
    expect(workflow).toContain("npx tsx scripts/preflight_database.ts");
    expect(workflow).toContain("npx tsx scripts/verify_migration_status.ts");
    expect(dispatchPolicy).toContain("applicationRecordId: process.env.INPUT_APPLICATION_RECORD_ID");
  });
});
