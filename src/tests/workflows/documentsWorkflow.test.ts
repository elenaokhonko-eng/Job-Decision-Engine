import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("documents workflow", () => {
  it("requires pinned application and job identities before document generation", () => {
    const workflow = readFileSync(resolve(".github/workflows/documents.yml"), "utf8");
    const preflight = readFileSync(resolve("scripts/preflight_application_document_draft.ts"), "utf8");
    const pairValidator = readFileSync(resolve("scripts/validate_application_document_pair.ts"), "utf8");
    const artifactVerifier = readFileSync(resolve("scripts/verify_document_artifacts.ts"), "utf8");

    expect(workflow).toContain("application_record_id:");
    expect(workflow).toContain("required: true");
    expect(workflow).toContain("refs/heads/main");
    expect(workflow).toContain("APPLICATION_RECORD_ID=$INPUT_APPLICATION_RECORD_ID");
    expect(workflow).toContain("DOCUMENTS_JOB_FOUND=true");
    expect(preflight).toContain('application.status !== "INTENT"');
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
    expect(workflow).toContain("canonical_job_id, job_version_id, and application_record_id must all be valid UUIDs.");
  });
});
